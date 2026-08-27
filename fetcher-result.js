document.addEventListener('ll-fetcher-done', (e) => {
    chrome.runtime.sendMessage({ target: 'ext', event: 'FETCHER_RESULT', data: e.detail });
});
