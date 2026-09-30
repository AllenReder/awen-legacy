export function releaseAssetNames(version: string): string[];
export function verifyReleaseAssets(
  directory: string,
  version: string,
  assemble?: boolean,
): Promise<void>;
