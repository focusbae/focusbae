"use strict";
// The local workspace and microphone each define their own narrower session.
module.exports.installSessionPolicy = function (session) {
  session.webRequest.onBeforeRequest((details, callback) => {
    try {
      const protocol = new URL(details.url).protocol;
      callback({ cancel: !["file:", "data:", "devtools:"].includes(protocol) });
    } catch { callback({ cancel: true }); }
  });
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
};
