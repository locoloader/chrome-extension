// chrome.storage.local.clear()

const checkBoxOptions = {
    btDlAllFolder: document.getElementById('btDlAllFolder'),
    btDlFolder: document.getElementById('btDlFolder')
}

const checkBoxOptionsDefaultValues = {
    btDlAllFolder: true,
    btDlFolder: false
}
const getSetCheckBoxVal = (el) => {
    chrome.storage.local.get(el.id, (res) => {
        if (res.hasOwnProperty(el.id)) {
            el.checked = res[el.id]
        } else if (checkBoxOptionsDefaultValues.hasOwnProperty(el.id)) {
            el.checked = checkBoxOptionsDefaultValues[el.id]
        }
        chrome.storage.local.set({[el.id]: el.checked})
    })
}

const setCheckBoxVal = (el) => {
    chrome.storage.local.set({[el.id]: el.checked})
    chrome.runtime.sendMessage({
        option: true,
        optionName: el.id,
        optionVal: el.checked
    })
}

// Init
for (const key in checkBoxOptions) {
    const checkbox = checkBoxOptions[key]

    // Get and set default values
    getSetCheckBoxVal(checkbox)

    // Set value on click event
    checkbox.onclick = () => {
        setCheckBoxVal(checkbox)
    }
}
