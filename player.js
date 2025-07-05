const params = new URLSearchParams(location.search);
const src = params.get("src");
if (src) {
    document.getElementById("videoSrc").src = src;
    document.querySelector("video").load();
} else {
    document.body.textContent = "Error: no video URL provided.";
}