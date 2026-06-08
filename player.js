(async () => {
    const params = new URLSearchParams(location.search);
    const previewId = params.get('previewId');
    const linkType = params.get('data');

    if (!previewId) {
        document.body.textContent = 'Error: Missing session ID(1).';
        return;
    }

    if (!linkType || (linkType !== 'raw' && linkType !== 'url')) {
        document.body.textContent = 'Error: Missing or invalid link type.';
        return;
    }

    const result = await chrome.storage.session.get(previewId);
    if (!result || !result[previewId]) {
        document.body.textContent = `Error: Session ID does not exist: ${previewId}`;
        return;
    }

    await chrome.storage.session.remove(previewId);

    const video = document.getElementById('video');

    let sourceUrl;
    let isHls = false; // Add a flag to route the playback method

    if (linkType === 'raw') {
        // Raw text manifests are always HLS
        isHls = true;

        const byteCharacters = atob(result[previewId]);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);

        const blob = new Blob([byteArray], {
            type: 'application/vnd.apple.mpegurl',
        });

        sourceUrl = URL.createObjectURL(blob);
        console.log('Manifest created from raw data. Size in bytes:', byteArray.length);
    } else {
        sourceUrl = result[previewId];

        // Check if the URL points to an HLS playlist
        if (sourceUrl.toLowerCase().includes('.m3u')) {
            isHls = true;
        }
        console.log('Using remote URL address directly.');
    }

    // Playback Routing
    if (isHls) {
        // Route through HLS.js or native Apple HLS
        if (Hls.isSupported()) {
            console.log('Using HLS.js');
            const hls = new Hls({
                enableWorker: true,
                workerPath: 'libs/hls.worker.js',
            });

            hls.loadSource(sourceUrl);
            hls.attachMedia(video);

            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.log('Fatal network error: ' + data.details + '. Trying to recover...');
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.log('Fatal media error: ' + data.details + '. Trying to recover...');
                            hls.recoverMediaError();
                            break;
                        default:
                            console.log('Unrecoverable error: ' + data.details);
                            hls.destroy();
                            break;
                    }
                } else if (data.details === 'manifestLoadError') {
                    console.log('Check CORS headers on the remote server!');
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            console.log('Using Native Safari HLS Player');
            video.src = sourceUrl;
            video.addEventListener('error', (e) => console.log('Native Error: ' + video.error.code));
        }
    } else {
        // Standard formats (MP4, MP3, WEBM) play natively without the HLS library
        console.log('Using Native HTML5 Media Player');
        video.src = sourceUrl;
        video.addEventListener('error', (e) => console.log('Native Error: ' + video.error.code));
    }
})();
