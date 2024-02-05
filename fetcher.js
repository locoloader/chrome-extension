// Obtain AsyncFunction
// @link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncFunction
const LLAsyncFunction = (async function () {}).constructor;

// Actions
const LLActionsErrors = [];
const LLActionsScraped = [];
const LLActions = {
    element: (selector) => {
        return new Promise((resolve) => {
            if (typeof selector !== 'string') {
                LLActionsErrors.push('Type error: Element selector must be a string.');
                resolve();
                return;
            }

            const el = document.querySelector(selector);
            if (!el) {
                LLActionsErrors.push('DOM error: Element not found.');
                resolve();
                return;
            }

            LLActionsScraped.push(el.outerHTML);
            resolve();
        });
    },
    elements: (selector) => {
        return new Promise((resolve) => {
            if (typeof selector !== 'string') {
                LLActionsErrors.push('Type error: Element selector must be a string.');
                resolve();
                return;
            }

            const els = document.querySelectorAll(selector);
            if (!els.length) {
                LLActionsErrors.push('DOM error: Element not found.');
                resolve();
                return;
            }

            for (const el of els) {
                LLActionsScraped.push(el.outerHTML);
            }

            resolve();
        });
    },
    click: (selector) => {
        return new Promise((resolve) => {
            if (typeof selector !== 'string') {
                LLActionsErrors.push('Type error: Click selector must be a string.');
                resolve();
                return;
            }

            const el = document.querySelector(selector);
            if (!el) {
                LLActionsErrors.push('DOM error: Click element not found.');
                resolve();
                return;
            }

            el.click();
            resolve();
        });
    },
    fill: (array) => {
        return new Promise((resolve) => {
            if (array.constructor.name !== 'Array') {
                LLActionsErrors.push('Type error: Fill parameter must be an array.');
                resolve();
                return;
            }

            if (!array[0] || typeof array[0] !== 'string') {
                LLActionsErrors.push('Type error: Fill selector must be a string.');
                resolve();
                return;
            }

            if (!array[1] || (typeof array[1] !== 'string' && typeof array[1] !== 'number')) {
                LLActionsErrors.push('Type error: Fill value must be a string or a number.');
                resolve();
                return;
            }

            const el = document.querySelector(array[0]);
            if (!el) {
                LLActionsErrors.push('DOM error: Fill element not found.');
                resolve();
                return;
            }

            if (el.tagName.toLowerCase() !== 'input' && el.tagName.toLowerCase() !== 'textarea') {
                LLActionsErrors.push('DOM error: Fill element must be input or textarea.');
                resolve();
                return;
            }

            el.value = array[1];
            resolve();
        });
    },
    scrollX: (offset) => {
        return new Promise((resolve) => {
            if (typeof offset !== 'number') {
                LLActionsErrors.push('Type error: ScrollX parameter must be a number.');
                resolve();
                return;
            }
            document.documentElement.scrollLeft = document.body.scrollLeft = offset;
            resolve();
        });
    },
    scrollY: (offset) => {
        return new Promise((resolve) => {
            if (typeof offset !== 'number') {
                LLActionsErrors.push('Type error: ScrollY parameter must be a number.');
                resolve();
                return;
            }
            document.documentElement.scrollTop = document.body.scrollTop = offset;
            resolve();
        });
    },
    scrollTo: (selector) => {
        return new Promise((resolve) => {
            if (typeof selector !== 'string') {
                LLActionsErrors.push('Type error: ScrollTo parameter must be a string.');
                resolve();
                return;
            }

            const el = document.querySelector(selector);
            if (!el) {
                LLActionsErrors.push('DOM error: ScrollTo element not found.');
                resolve();
                return;
            }

            el.scrollIntoView({
                block: 'center',
                inline: 'center',
            })

            resolve();
        });
    },
    wait: (ms) => {
        return new Promise((resolve) => {
            if (typeof ms !== 'number') {
                LLActionsErrors.push('Type error: Wait parameter must be a number.');
                resolve();
                return;
            }

            // Allow waiting for 20s max
            if (ms > 20000) {
                ms = 20000;
            }

            setTimeout(resolve, ms);
        });
    },
    waitFor: (selector) => {
        return new Promise((resolve) => {
            let maxTime = 30000;

            if (selector.constructor.name === 'Array') {
                if (!selector[0] || typeof selector[0] !== 'string') {
                    LLActionsErrors.push('Type error: WaitFor selector[0] must be a string.');
                    resolve();
                    return;
                }

                if (!selector[1] || typeof selector[1] !== 'number') {
                    LLActionsErrors.push('Type error: WaitFor selector[1] must be a number.');
                    resolve();
                    return;
                }

                maxTime = selector[1];
                selector = selector[0];

            } else if (typeof selector !== 'string') {
                LLActionsErrors.push('Type error: WaitFor selector must be a string.');
                resolve();
                return;
            }

            if (document.querySelector(selector)) {
                resolve();
                return;
            }

            const observer = new MutationObserver(() => {
                if (document.querySelector(selector)) {
                    observer.disconnect();
                    resolve();
                    return;
                }
            });

            observer.observe(document, {
                childList: true,
                subtree: true
            });

            // Don't wait more than 30s for an element, 30s is the API response limit
            setTimeout(() => {
                observer.disconnect();
                resolve();
            }, maxTime);
        });
    },
    eval: (code) => {
        return new Promise((resolve) => {
            if (typeof code !== 'string') {
                LLActionsErrors.push('Type error: Code to evaluate must be a string.');
                resolve();
                return;
            }

            code = 'async function SB_go() {' + code + '} resolve(await SB_go());'
            new LLAsyncFunction('resolve', code)(resolve)
        })
    },
};

// Data fetcher
function fetcher(LLPage) {
    return new Promise(async (resolve) => {
        // Default response
        let response = {
            url: LLPage.url,
            headers: {},
            html: '',
            dom: '',
            actions: {
                err: [],
                result: [],
            },
            xhr: [],
            windowURL: LLPage.windowURL,
        }

        // Prepare HTTP headers for fetch request
        let fetchOptions = {};
        if (LLPage.headers && LLPage.headers.requestHeaders && LLPage.headers.requestHeaders.action) {
            for (const header of LLPage.headers.action.requestHeaders) {
                if (header.operation === 'set' || header.operation === 'append') {
                    fetchOptions['headers'][header.header] = header.value;
                }
            }
        }

        // Fetch original page HTML...
        const fetchResponse = await fetch(LLPage.url, fetchOptions);

        // ...if status code is 503, 403, re-fetch page
        if ((fetchResponse.status === 503  || fetchResponse.status === 403) && !LLPage.hasOwnProperty('doNotReFetch')) {
            response['reFetch'] = true;
            resolve(response);
            return;
        }

        // ...get original page HTML
        response.html = await fetchResponse.text();

        // ...get page HTTP headers
        response.headers = Object.fromEntries(fetchResponse.headers.entries());

        // Evaluate JS code and get the result (if any)
        if (LLPage.actions) {
            const resultArr = [];
            for (const index in LLPage.actions) {
                for (const key in LLPage.actions[index]) {
                    const result = await LLActions[key](LLPage.actions[index][key]);
                    if (result) {
                        resultArr.push(result);
                    }
                }
            }
            response.actions.result = resultArr;
            response.actions.err = LLActionsErrors;
        }

        if (LLActionsScraped.length > 0) {
            // Get scraped data with actions
            response.dom = LLActionsScraped;

        } else {
            // Get original page DOM
            if (document.doctype) {
                response.dom = new XMLSerializer().serializeToString(document.doctype) + document.getElementsByTagName('html')[0].outerHTML;
            } else {
                response.dom = document.getElementsByTagName('html')[0].outerHTML;
            }
        }

        // Perform XHR tasks (if any)
        if (LLPage.xhr) {
            for (const xhr of LLPage.xhr) {
                const fetchResponse = await fetch(xhr.url, xhr.fetchOptions ? xhr.fetchOptions : {});
                const fetchResponseText = await fetchResponse.text();
                response.xhr.push({
                    'url': xhr.url,
                    'html': fetchResponseText
                })
            }
        }

        resolve(response);
    });
}

// Fetch data from LLPage
fetcher(document.LLPage);