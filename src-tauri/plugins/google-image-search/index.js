(function () {
  var SEARCH_TIMEOUT = 10000;
  var POLL_INTERVAL = 500;

  var EXTRACT_SCRIPT =
    '(function() {' +
    '  var imgs = document.querySelectorAll("img");' +
    '  for (var i = 0; i < imgs.length; i++) {' +
    '    var src = imgs[i].src || "";' +
    '    if (src.indexOf("http") !== 0) continue;' +
    '    if (src.indexOf("google") !== -1) continue;' +
    '    if (src.indexOf("gstatic") !== -1) continue;' +
    '    var w = imgs[i].naturalWidth || imgs[i].width || 0;' +
    '    var h = imgs[i].naturalHeight || imgs[i].height || 0;' +
    '    if (w < 80 || h < 80) continue;' +
    '    window.__viboplr.send("image-result", src);' +
    '    return;' +
    '  }' +
    '  window.__viboplr.send("image-result", null);' +
    '})();';

  function activate(api) {
    var activeHandle = null;

    api.imageProviders.onFetch("tag", function (tagName) {
      var searchUrl =
        "https://www.google.com/search?tbm=isch&q=" +
        encodeURIComponent(tagName);

      if (activeHandle) {
        activeHandle.close().catch(console.error);
        activeHandle = null;
      }

      return api.network
        .openBrowseWindow(searchUrl, {
          visible: false,
          width: 1024,
          height: 768,
        })
        .then(function (handle) {
          activeHandle = handle;

          return new Promise(function (resolve) {
            var settled = false;
            var pollTimer = null;
            var deadline = null;

            function finish(url) {
              if (settled) return;
              settled = true;
              if (pollTimer) clearInterval(pollTimer);
              if (deadline) clearTimeout(deadline);
              activeHandle = null;
              handle.close().catch(console.error);
              if (url) {
                resolve({ status: "ok", url: url });
              } else {
                resolve({ status: "not_found" });
              }
            }

            handle.onMessage(function (msg) {
              if (msg.type === "image-result") {
                finish(msg.data);
              }
            });

            pollTimer = setInterval(function () {
              handle.eval(EXTRACT_SCRIPT).catch(function () {
                finish(null);
              });
            }, POLL_INTERVAL);

            deadline = setTimeout(function () {
              finish(null);
            }, SEARCH_TIMEOUT);
          });
        })
        .catch(function (e) {
          api.log("warn", "Google image search failed: " + e);
          return { status: "error", message: String(e) };
        });
    });
  }

  return { activate: activate };
})();
