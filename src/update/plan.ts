import type { ExtensionRelease } from './extensionUpdate';

export interface DshOffer { current: string; latest: string }
export interface UpdateOffer { extension?: ExtensionRelease; dsh?: DshOffer }
export interface UpdatePlan {
  /** A DSH update is out and a newer plugin release exists, so the plugin must update before DSH-IDE is usable. */
  required: boolean;
  extension?: ExtensionRelease;
  dsh?: DshOffer;
}

/** One decision for both updaters. Returns undefined when there is nothing to offer. */
export function planUpdates(
  offer: UpdateOffer,
  options: { promptOptional: boolean; skippedDsh?: string },
): UpdatePlan | undefined {
  const { extension, dsh } = offer;
  if (dsh && extension) return { required: true, extension, dsh };
  if (!options.promptOptional) return undefined;
  if (extension) return { required: false, extension };
  if (dsh && dsh.latest !== options.skippedDsh) return { required: false, dsh };
  return undefined;
}
