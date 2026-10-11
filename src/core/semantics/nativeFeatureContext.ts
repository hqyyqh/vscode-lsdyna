
export function nativeFordEnabled(value: string | undefined): boolean {
    return ['on', 'yes'].includes(value?.toLowerCase() ?? '');
}
export const nativeFordFeatureEnabled = nativeFordEnabled(process.env.LSPP_FORD);
export const NATIVE_FEATURE_IDENTITY = `native-ford-${Number(nativeFordFeatureEnabled)}`;
