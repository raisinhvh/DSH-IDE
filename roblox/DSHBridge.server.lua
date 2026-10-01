local HttpService = game:GetService("HttpService")
local CollectionService = game:GetService("CollectionService")
local RunService = game:GetService("RunService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local LogService = game:GetService("LogService")
if not RunService:IsEdit() then
	return
end

local sessionId = HttpService:GenerateGUID(false)
local playtestState = nil
local playtestError = nil
local BASE_URL = "http://127.0.0.1:34872"

-- Plugin chunk environment (Instance, game, print, math, …); not the shared _G table.
local pluginEnvironment = getfenv()

local toolbar = plugin:CreateToolbar("DSH")
local toggleButton = toolbar:CreateButton("DSHBridge", "Toggle the DSH Bridge", "")
toggleButton.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, true, false, 280, 140, 220, 110)
local widget = plugin:CreateDockWidgetPluginGuiAsync("DSHBridgeWidget", widgetInfo)
widget.Title = "DSH Bridge"
widget.Enabled = true

local background = Instance.new("Frame")
background.Name = "Background"
background.Size = UDim2.fromScale(1, 1)
background.BackgroundColor3 = Color3.fromRGB(35, 35, 38)
background.BorderSizePixel = 0
background.Parent = widget

local statusLabel = Instance.new("TextLabel")
statusLabel.Name = "Status"
statusLabel.Position = UDim2.fromOffset(10, 8)
statusLabel.Size = UDim2.new(1, -20, 1, -54)
statusLabel.BackgroundTransparency = 1
statusLabel.Font = Enum.Font.Gotham
statusLabel.TextColor3 = Color3.fromRGB(235, 235, 235)
statusLabel.TextSize = 16
statusLabel.TextWrapped = true
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.TextYAlignment = Enum.TextYAlignment.Top
statusLabel.Parent = background

local pairingBox = Instance.new("TextBox")
pairingBox.Name = "PairingCode"
pairingBox.Position = UDim2.new(0, 10, 1, -38)
pairingBox.Size = UDim2.new(1, -20, 0, 28)
pairingBox.BackgroundColor3 = Color3.fromRGB(52, 52, 56)
pairingBox.BorderSizePixel = 0
pairingBox.ClearTextOnFocus = false
pairingBox.Font = Enum.Font.GothamMedium
pairingBox.PlaceholderText = "Pairing code"
pairingBox.PlaceholderColor3 = Color3.fromRGB(160, 160, 165)
pairingBox.TextColor3 = Color3.fromRGB(240, 240, 240)
pairingBox.TextSize = 14
pairingBox.TextXAlignment = Enum.TextXAlignment.Left
pairingBox.Parent = background

local function trim(value)
	return (value:gsub("^%s*(.-)%s*$", "%1"))
end

local savedCode = plugin:GetSetting("DSHPairingCode")
local pairingCode = type(savedCode) == "string" and string.upper(trim(savedCode)) or ""
pairingBox.Text = pairingCode

local function setStatus(value)
	statusLabel.Text = value
end

local function splitPath(path)
	local separator = string.find(path, "/", 1, true) and "/" or "."
	local segments = {}
	for segment in string.gmatch(path, "[^" .. separator .. "]+") do
		if segment ~= "" then
			table.insert(segments, segment)
		end
	end
	if segments[1] == "game" then
		table.remove(segments, 1)
	end
	return segments
end

local function resolvePath(path)
	path = type(path) == "string" and path or ""
	local segments = splitPath(path)
	if #segments == 0 then
		return game
	end

	local current = game:FindFirstChild(segments[1])
	if not current then
		local ok, service = pcall(game.GetService, game, segments[1])
		if ok then
			current = service
		end
	end
	if not current then
		error(string.format('No instance at path "%s": "%s" was not found under "game"', path, segments[1]), 0)
	end

	local traversed = { segments[1] }
	for index = 2, #segments do
		local name = segments[index]
		local child = current:FindFirstChild(name)
		if not child then
			local parentPath = table.concat(traversed, "/")
			error(string.format('No instance at path "%s": "%s" was not found under "%s"', path, name, parentPath), 0)
		end
		current = child
		table.insert(traversed, name)
	end
	return current
end

local function instancePath(instance)
	if instance == game then
		return "game"
	end
	local segments = {}
	local current = instance
	while current and current ~= game do
		table.insert(segments, 1, current.Name)
		current = current.Parent
	end
	return table.concat(segments, "/")
end

local function clampNumber(value, defaultValue, minimum, maximum)
	local number = tonumber(value) or defaultValue
	return math.clamp(math.floor(number), minimum, maximum)
end

local function sortedChildren(instance)
	local children = instance:GetChildren()
	table.sort(children, function(left, right)
		if left.Name == right.Name then
			return left.ClassName < right.ClassName
		end
		return left.Name < right.Name
	end)
	return children
end

local function matchesClass(instance, className)
	if not className or className == "" then
		return true
	end
	local ok, matches = pcall(function()
		return instance:IsA(className)
	end)
	return ok and matches
end

local function treeOperation(args)
	local root = resolvePath(args.path)
	local depthLimit = clampNumber(args.depth, 3, 0, 20)
	local maxNodes = clampNumber(args.maxNodes, 300, 1, 2000)
	local className = type(args.className) == "string" and args.className or nil
	local rootInfo = { path = instancePath(root), className = root.ClassName, childCount = #root:GetChildren() }
	local nodes = {}
	local stack = {}
	local visited = 0
	local truncated = false

	local function pushChildren(instance, depth)
		local children = sortedChildren(instance)
		for index = #children, 1, -1 do
			table.insert(stack, { instance = children[index], depth = depth })
		end
	end

	if depthLimit > 0 then
		pushChildren(root, 1)
	end
	-- Pre-order so the listing reads as an indented hierarchy; the root is reported separately.
	while #stack > 0 do
		local entry = table.remove(stack)
		visited = visited + 1
		if matchesClass(entry.instance, className) then
			if #nodes >= maxNodes then
				truncated = true
				break
			end
			table.insert(nodes, {
				path = instancePath(entry.instance),
				name = entry.instance.Name,
				className = entry.instance.ClassName,
				depth = entry.depth,
				childCount = #entry.instance:GetChildren(),
			})
		end
		if entry.depth < depthLimit then
			pushChildren(entry.instance, entry.depth + 1)
		end
		if visited % 500 == 0 then
			task.wait()
		end
	end

	return { root = rootInfo, nodes = nodes, truncated = truncated, total = visited }
end

local function findOperation(args)
	local start = resolvePath(args.path)
	local nameNeedle = type(args.name) == "string" and string.lower(args.name) or nil
	local className = type(args.className) == "string" and args.className or nil
	if (not nameNeedle or nameNeedle == "") and (not className or className == "") then
		error("find requires name or className", 0)
	end
	local limit = clampNumber(args.limit, 50, 1, 500)
	local matches = {}
	local stack = {}
	for _, child in ipairs(sortedChildren(start)) do
		table.insert(stack, child)
	end
	local visited = 0
	local truncated = false
	while #stack > 0 do
		local instance = table.remove(stack)
		visited = visited + 1
		local nameMatches = not nameNeedle
			or nameNeedle == ""
			or string.find(string.lower(instance.Name), nameNeedle, 1, true) ~= nil
		if nameMatches and matchesClass(instance, className) then
			table.insert(matches, { path = instancePath(instance), className = instance.ClassName })
			if #matches >= limit then
				truncated = #stack > 0 or #instance:GetChildren() > 0
				break
			end
		end
		local children = sortedChildren(instance)
		for index = #children, 1, -1 do
			table.insert(stack, children[index])
		end
		if visited % 500 == 0 then
			task.wait()
		end
	end
	return { matches = matches, truncated = truncated }
end

local DEFAULT_PROPERTIES = {
	"Name",
	"ClassName",
	"Parent",
	"Archivable",
	"Position",
	"Size",
	"CFrame",
	"Orientation",
	"Anchored",
	"CanCollide",
	"CanTouch",
	"CanQuery",
	"Massless",
	"Transparency",
	"Color",
	"BrickColor",
	"Material",
	"Shape",
	"Text",
	"TextColor3",
	"Font",
	"TextSize",
	"Visible",
	"Enabled",
	"Active",
	"ZIndex",
	"LayoutOrder",
	"AnchorPoint",
	"BackgroundColor3",
	"BackgroundTransparency",
	"Image",
	"ImageColor3",
	"Value",
	"Disabled",
	"RunContext",
	"LinkedSource",
	"Brightness",
	"Range",
	"Volume",
	"SoundId",
	"Looped",
	"PlaybackSpeed",
	"MeshId",
	"TextureID",
	"Health",
	"MaxHealth",
	"WalkSpeed",
	"JumpPower",
	"JumpHeight",
	"DisplayName",
	"PrimaryPart",
	"Adornee",
}

local function valueToString(value)
	if typeof(value) == "Instance" then
		return instancePath(value)
	end
	return tostring(value)
end

local function propertiesOperation(args)
	if type(args.path) ~= "string" then
		error('properties requires "path"', 0)
	end
	local instance = resolvePath(args.path)
	local properties = {}
	local requested = args.properties
	local explicit = type(requested) == "table"
	if not explicit then
		requested = DEFAULT_PROPERTIES
	end
	for _, propertyName in ipairs(requested) do
		if type(propertyName) == "string" then
			local ok, value = pcall(function()
				return instance[propertyName]
			end)
			if ok then
				if value ~= nil then
					properties[propertyName] = valueToString(value)
				end
			else
				properties[propertyName] = "<unreadable>"
			end
		end
	end

	local attributes = {}
	local attributesOk, rawAttributes = pcall(function()
		return instance:GetAttributes()
	end)
	if attributesOk then
		for name, value in pairs(rawAttributes) do
			attributes[name] = valueToString(value)
		end
	end
	local tags = {}
	local tagsOk, rawTags = pcall(function()
		return CollectionService:GetTags(instance)
	end)
	if tagsOk then
		tags = rawTags
	end
	return {
		path = instancePath(instance),
		className = instance.ClassName,
		name = instance.Name,
		childCount = #instance:GetChildren(),
		properties = properties,
		attributes = attributes,
		tags = tags,
	}
end

local function sourceOperation(args)
	if type(args.path) ~= "string" then
		error('source requires "path"', 0)
	end
	local instance = resolvePath(args.path)
	if not instance:IsA("LuaSourceContainer") then
		error("Instance is not a LuaSourceContainer", 0)
	end
	local maxChars = clampNumber(args.maxChars, 20000, 100, 200000)
	local ok, source = pcall(function()
		return instance.Source
	end)
	if not ok then
		error("Source is not readable", 0)
	end
	local lineCount = 0
	for _ in string.gmatch(source, "[^\n]*\n?") do
		lineCount = lineCount + 1
	end
	if #source == 0 then
		lineCount = 0
	end
	local result = {
		path = instancePath(instance),
		className = instance.ClassName,
		source = string.sub(source, 1, maxChars),
		truncated = #source > maxChars,
		lineCount = lineCount,
	}
	if instance:IsA("Script") then
		local runOk, runContext = pcall(function()
			return instance.RunContext
		end)
		if runOk then
			result.runContext = tostring(runContext)
		end
	end
	return result
end

local EXECUTE_MAX_CODE_BYTES = 200000
local EXECUTE_MAX_LOG_LINES = 100
local EXECUTE_MAX_LINE_CHARS = 2000
local EXECUTE_MAX_RETURNS = 100
local EXECUTE_TIMEOUT_SECONDS = 20
local UTF8_REPLACEMENT = "\239\191\189"

local function boundExecuteText(text)
	local parts = {}
	local byteCount = 0
	local index = 1
	local length = #text
	local replacementLen = #UTF8_REPLACEMENT

	while index <= length do
		local codepointOk, codepoint = pcall(utf8.codepoint, text, index)
		if codepointOk and codepoint then
			local char = utf8.char(codepoint)
			local charLen = #char
			if byteCount + charLen > EXECUTE_MAX_LINE_CHARS then
				break
			end
			parts[#parts + 1] = char
			byteCount = byteCount + charLen
			index = index + charLen
		else
			if byteCount + replacementLen > EXECUTE_MAX_LINE_CHARS then
				break
			end
			parts[#parts + 1] = UTF8_REPLACEMENT
			byteCount = byteCount + replacementLen
			index = index + 1
		end
	end

	local sanitized = table.concat(parts)
	if index <= length then
		sanitized = sanitized .. "..."
	end
	return sanitized
end

local OUTPUT_LOG_MAX_ENTRIES = 2000
local outputLog = {}
local logLevelMap = {
	[Enum.MessageType.MessageOutput] = "output",
	[Enum.MessageType.MessageInfo] = "info",
	[Enum.MessageType.MessageWarning] = "warning",
	[Enum.MessageType.MessageError] = "error",
}

local function appendOutputLog(message, messageType, timestamp)
	local level = logLevelMap[messageType] or "output"
	table.insert(outputLog, {
		timestamp = tonumber(timestamp) or os.time(),
		level = level,
		message = boundExecuteText(tostring(message or "")),
	})
	if #outputLog > OUTPUT_LOG_MAX_ENTRIES then
		table.remove(outputLog, 1)
	end
end

local historyOk, logHistory = pcall(function()
	return LogService:GetLogHistory()
end)
if historyOk and type(logHistory) == "table" then
	for _, entry in ipairs(logHistory) do
		if type(entry) == "table" then
			appendOutputLog(entry.message, entry.messageType, entry.timestamp)
		end
	end
end

local messageOutConnection = LogService.MessageOut:Connect(function(message, messageType)
	appendOutputLog(message, messageType, os.time())
end)

local function outputLogOperation(args)
	local limit = clampNumber(args.limit, 100, 1, 1000)
	local requestedLevel = type(args.level) == "string" and string.lower(args.level) or "all"
	if requestedLevel == "warn" then
		requestedLevel = "warning"
	end
	if
		requestedLevel ~= "all"
		and requestedLevel ~= "output"
		and requestedLevel ~= "info"
		and requestedLevel ~= "warning"
		and requestedLevel ~= "error"
	then
		error('level must be "all", "output", "info", "warning", or "error"', 0)
	end
	local contains = type(args.contains) == "string" and string.lower(args.contains) or nil
	local sinceTimestamp = tonumber(args.sinceTimestamp)
	local matches = {}
	for _, entry in ipairs(outputLog) do
		if
			(requestedLevel == "all" or requestedLevel == entry.level)
			and (not contains or string.find(string.lower(entry.message), contains, 1, true))
			and (not sinceTimestamp or entry.timestamp > sinceTimestamp)
		then
			table.insert(matches, entry)
		end
	end
	local entries = {}
	local first = math.max(1, #matches - limit + 1)
	for index = first, #matches do
		local entry = matches[index]
		table.insert(entries, { timestamp = entry.timestamp, level = entry.level, message = entry.message })
	end
	local result = { entries = entries, total = #matches, truncated = #matches > limit }
	if args.clear == true then
		table.clear(outputLog)
	end
	return result
end

local function selectionList(selectionService)
	local result = {}
	for _, instance in ipairs(selectionService:Get()) do
		table.insert(result, { path = instancePath(instance), className = instance.ClassName })
	end
	return result
end

local function selectionOperation(args)
	local ok, selectionService = pcall(game.GetService, game, "Selection")
	if not ok then
		error("Cannot access Selection: " .. tostring(selectionService), 0)
	end
	local action = args.action or "get"
	if action ~= "get" and action ~= "set" then
		error('action must be "get" or "set"', 0)
	end
	if action == "get" then
		local getOk, selection = pcall(selectionList, selectionService)
		if not getOk then
			error("Cannot get selection: " .. tostring(selection), 0)
		end
		return { selection = selection }
	end
	if type(args.paths) ~= "table" then
		error('selection set requires "paths" to be an array of strings', 0)
	end
	local resolved = {}
	local missing = {}
	local pathCount = 0
	for key, path in pairs(args.paths) do
		if type(path) ~= "string" or type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
			error('selection set requires "paths" to be an array of strings', 0)
		end
		pathCount = pathCount + 1
	end
	if pathCount ~= #args.paths then
		error('selection set requires "paths" to be an array of strings', 0)
	end
	for _, path in ipairs(args.paths) do
		local resolveOk, instance = pcall(resolvePath, path)
		if resolveOk then
			table.insert(resolved, instance)
		else
			table.insert(missing, path)
		end
	end
	local setOk, setError = pcall(selectionService.Set, selectionService, resolved)
	if not setOk then
		error("Cannot set selection: " .. tostring(setError), 0)
	end
	local getOk, selection = pcall(selectionList, selectionService)
	if not getOk then
		error("Cannot get selection: " .. tostring(selection), 0)
	end
	return { selection = selection, missing = missing }
end

local function playtestOperation(args)
	local action = args.action
	if action ~= "status" and action ~= "start" and action ~= "stop" then
		error('action must be "status", "start", or "stop"', 0)
	end
	local mode = args.mode or "run"
	if mode ~= "run" and mode ~= "play" then
		error('mode must be "run" or "play"', 0)
	end
	local isRunningOk, isRunning = pcall(RunService.IsRunning, RunService)
	if not isRunningOk then
		error("Cannot check playtest status: " .. tostring(isRunning), 0)
	end
	if action == "status" then
		local state = playtestState or (isRunning and "run" or "edit")
		local running = isRunning or playtestState ~= nil
		local message = playtestError and ("Playtest failed: " .. playtestError)
			or (running and "Playtest is running" or "Studio is in edit mode")
		playtestError = nil
		return { running = running, state = state, message = message }
	end
	if action == "start" then
		if isRunning or playtestState ~= nil then
			error("A playtest is already running", 0)
		end
		if mode == "run" then
			local runOk, runError = pcall(RunService.Run, RunService)
			if not runOk then
				error("Cannot start playtest: " .. tostring(runError), 0)
			end
		else
			local serviceOk, testService = pcall(game.GetService, game, "StudioTestService")
			if not serviceOk then
				error("Cannot start playtest: " .. tostring(testService), 0)
			end
			playtestState = "play"
			task.spawn(function()
				local executeOk, executeError = pcall(function()
					testService:ExecutePlayModeAsync(nil)
				end)
				if not executeOk then
					playtestError = tostring(executeError)
				end
				playtestState = nil
			end)
		end
		return { running = true, state = mode, message = "Playtest started" }
	end
	if not isRunning and playtestState == nil then
		return { running = false, state = "edit", message = "No playtest was running" }
	end
	local serviceOk, testService = pcall(game.GetService, game, "StudioTestService")
	local endOk, endError = false, testService
	if serviceOk then
		endOk, endError = pcall(testService.EndTest, testService)
	end
	local stopOk, stopError = pcall(RunService.Stop, RunService)
	if not stopOk and not endOk then
		error("Cannot stop playtest: " .. tostring(stopError) .. "; EndTest: " .. tostring(endError), 0)
	end
	playtestState = nil
	return { running = false, state = "edit", message = "Playtest stopped" }
end

local function executeInstancePathString(instance)
	local pathOk, path = pcall(instancePath, instance)
	if not pathOk then
		return "<instance path unavailable>"
	end
	return boundExecuteText(path)
end

local function executeOutputString(value)
	if value == nil then
		return "nil"
	end
	if typeof(value) == "Instance" then
		return executeInstancePathString(value)
	end
	local ok, text = pcall(tostring, value)
	if not ok then
		return "<unstringifiable>"
	end
	return boundExecuteText(text)
end

local function appendExecuteLog(logs, line, logState)
	if logState.truncated then
		return
	end
	if #logs >= EXECUTE_MAX_LOG_LINES then
		logState.truncated = true
		table.insert(logs, "(log output truncated)")
		return
	end
	table.insert(logs, boundExecuteText(line))
end

local function formatExecuteLogArgs(...)
	local count = select("#", ...)
	local parts = {}
	for index = 1, count do
		parts[index] = executeOutputString(select(index, ...))
	end
	return table.concat(parts, "\t")
end

local function buildExecuteEnvironment(logs, logState)
	local env = setmetatable({}, { __index = pluginEnvironment })
	env._G = env
	function env.print(...)
		appendExecuteLog(logs, formatExecuteLogArgs(...), logState)
	end
	function env.warn(...)
		appendExecuteLog(logs, formatExecuteLogArgs(...), logState)
	end
	return env
end

local function formatExecuteError(message, logs)
	if #logs == 0 then
		return message
	end
	return message .. "\n\nOutput:\n" .. table.concat(logs, "\n")
end

local function executeOperation(args)
	if type(args.code) ~= "string" then
		error('execute requires "code"', 0)
	end
	local code = args.code
	if trim(code) == "" then
		error("code must be a nonblank string", 0)
	end
	if #code > EXECUTE_MAX_CODE_BYTES then
		error("code must be at most 200000 bytes", 0)
	end

	local loadstringOk, chunk, compileErr = pcall(loadstring, code, "DSHBridgeExecute")
	if not loadstringOk then
		error("loadstring is unavailable in this Studio context: " .. executeOutputString(chunk), 0)
	end
	if not chunk then
		error("Compile error: " .. executeOutputString(compileErr), 0)
	end

	local recording = nil
	if not RunService:IsRunning() then
		recording = ChangeHistoryService:TryBeginRecording("DSHBridge.Execute", "DSH Execute")
		if not recording then
			error("Cannot execute: Studio is not accepting undo recordings.", 0)
		end
	end

	local function finishRecording(operation)
		if recording then
			ChangeHistoryService:FinishRecording(recording, operation)
		end
	end

	local logs = {}
	local logState = { truncated = false }
	local envOk, envErr = pcall(setfenv, chunk, buildExecuteEnvironment(logs, logState))
	if not envOk then
		finishRecording(Enum.FinishRecordingOperation.Cancel)
		error("Cannot prepare execution environment: " .. executeOutputString(envErr), 0)
	end

	local packed = nil
	local executionSucceeded = false
	local runtimeError = nil
	local finished = false
	local deadline = os.clock() + EXECUTE_TIMEOUT_SECONDS
	local thread = task.spawn(function()
		local ok, err = pcall(function()
			packed = table.pack(chunk())
		end)
		executionSucceeded = ok
		if not ok then
			runtimeError = err
		end
		finished = true
	end)

	while not finished and os.clock() < deadline do
		task.wait()
	end

	if not finished then
		task.cancel(thread)
		finishRecording(Enum.FinishRecordingOperation.Commit)
		error(
			formatExecuteError(
				"Execution timed out after 20 seconds; this only interrupts yielding code, while non-yielding loops cannot be interrupted and can freeze Studio.",
				logs
			),
			0
		)
	end

	if not executionSucceeded then
		finishRecording(Enum.FinishRecordingOperation.Commit)
		error(formatExecuteError(executeOutputString(runtimeError), logs), 0)
	end

	finishRecording(Enum.FinishRecordingOperation.Commit)

	local returns = {}
	local count = packed.n
	local returnsTruncated = count > EXECUTE_MAX_RETURNS
	for index = 1, math.min(count, EXECUTE_MAX_RETURNS) do
		returns[index] = executeOutputString(packed[index])
	end
	if returnsTruncated then
		table.insert(returns, "(return values truncated)")
	end
	return { logs = logs, returns = returns }
end

local function executeCommand(command)
	local args = type(command.args) == "table" and command.args or {}
	if command.op == "tree" then
		return treeOperation(args)
	elseif command.op == "find" then
		return findOperation(args)
	elseif command.op == "properties" then
		return propertiesOperation(args)
	elseif command.op == "source" then
		return sourceOperation(args)
	elseif command.op == "execute" then
		return executeOperation(args)
	elseif command.op == "output_log" then
		return outputLogOperation(args)
	elseif command.op == "selection" then
		return selectionOperation(args)
	elseif command.op == "playtest" then
		return playtestOperation(args)
	end
	error("Unknown op: " .. tostring(command.op), 0)
end

local function postResult(code, body)
	return HttpService:RequestAsync({
		Url = BASE_URL .. "/result",
		Method = "POST",
		Headers = {
			["x-dsh-token"] = code,
			["Content-Type"] = "application/json",
		},
		Body = HttpService:JSONEncode(body),
	})
end

pairingBox.FocusLost:Connect(function()
	pairingCode = string.upper(trim(pairingBox.Text))
	pairingBox.Text = pairingCode
	plugin:SetSetting("DSHPairingCode", pairingCode)
end)

toggleButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

local running = true
plugin.Unloading:Connect(function()
	running = false
	messageOutConnection:Disconnect()
end)

local function bridgeQuery()
	return "session="
		.. HttpService:UrlEncode(sessionId)
		.. "&placeId="
		.. HttpService:UrlEncode(tostring(game.PlaceId))
		.. "&place="
		.. HttpService:UrlEncode(game.Name)
end

-- A quick request that confirms DSH and the pairing code before the long poll starts.
local function connect(code)
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = BASE_URL .. "/ping?" .. bridgeQuery(),
			Method = "GET",
			Headers = { ["x-dsh-token"] = code },
		})
	end)
	-- 404: an older toolpack without /ping is still running, but it does answer /poll.
	if ok and (response.StatusCode == 200 or response.StatusCode == 404) then
		setStatus("Connected to DSH. Place: " .. game.Name)
		return true
	elseif ok and response.StatusCode == 401 then
		setStatus("Wrong pairing code.")
	elseif ok then
		setStatus("DSH answered with HTTP " .. response.StatusCode .. ". Re-upload the Roblox toolpack in DSH.")
	else
		setStatus(
			"DSH is not reachable ("
				.. tostring(response)
				.. "). Is the Roblox toolpack enabled in DSH, and are HTTP requests allowed?"
		)
	end
	return false
end

task.spawn(function()
	local lastReachable = false
	while running do
		local code = pairingCode
		if code == "" then
			setStatus("Enter the pairing code shown in DSH (Custom Tool Calls tab).")
			task.wait(0.5)
		elseif not lastReachable then
			setStatus("Connecting to DSH...")
			lastReachable = connect(code)
			if not running then
				break
			end
			if not lastReachable then
				task.wait(3)
			end
		else
			local ok, response = pcall(function()
				return HttpService:RequestAsync({
					Url = BASE_URL .. "/poll?" .. bridgeQuery(),
					Method = "GET",
					Headers = { ["x-dsh-token"] = code },
				})
			end)
			if not running then
				break
			end
			if not ok then
				lastReachable = false
				setStatus("DSH is not reachable. Open DSH and allow HTTP requests when Studio asks.")
				task.wait(3)
			elseif response.StatusCode == 401 then
				lastReachable = false
				setStatus("Wrong pairing code.")
				task.wait(3)
			elseif response.StatusCode == 204 then
				if not lastReachable then
					lastReachable = true
					setStatus("Connected to DSH. Place: " .. game.Name)
				end
				task.wait()
			elseif response.StatusCode == 200 then
				lastReachable = true
				setStatus("Connected to DSH. Place: " .. game.Name)
				local decodeOk, command = pcall(function()
					return HttpService:JSONDecode(response.Body)
				end)
				if decodeOk and type(command) == "table" then
					local commandOk, result = pcall(executeCommand, command)
					local body
					if commandOk then
						body = { id = command.id, ok = true, data = result }
					else
						body = { id = command.id, ok = false, error = tostring(result) }
					end
					local postOk = pcall(postResult, code, body)
					if not postOk then
						lastReachable = false
						setStatus("DSH is not reachable. Open DSH and allow HTTP requests when Studio asks.")
						task.wait(3)
					else
						task.wait()
					end
				else
					lastReachable = false
					setStatus("DSH is not reachable. Open DSH and allow HTTP requests when Studio asks.")
					task.wait(3)
				end
			else
				lastReachable = false
				setStatus("DSH is not reachable. Open DSH and allow HTTP requests when Studio asks.")
				task.wait(3)
			end
		end
	end
end)
