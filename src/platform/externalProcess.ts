const childProcess = require('child_process');

export function launchDetached(executable: string, args: string[], spawnProcess = childProcess.spawn) {
    const child = spawnProcess(executable, args, {
        shell: false,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
    });
    child.unref();
    return child;
}

export function openPdfWithSumatra(
    executable: string,
    pdfPath: string,
    pageNum?: number,
    fallback: () => void = () => {},
    spawnProcess = childProcess.spawn
) {
    let fallbackUsed = false;
    const useFallback = () => {
        if (fallbackUsed) return;
        fallbackUsed = true;
        fallback();
    };
    const args = ['-reuse-instance'];
    if (pageNum) args.push('-page', String(pageNum));
    args.push(pdfPath);

    try {
        const child = launchDetached(executable, args, spawnProcess);
        child.on('error', useFallback);
        return child;
    } catch (_error) {
        useFallback();
        return null;
    }
}
