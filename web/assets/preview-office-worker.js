/* 派生自 office-website v9.3.0.24/utils/editor/x2t.worker.ts；AGPL-3.0。 */
"use strict";
const base = self.location.origin + "/baba-share/vendor/office/x2t-1/";
let runtime;
const ready = new Promise((resolve, reject) => {
  self.Module = { locateFile: (name) => base + name, onRuntimeInitialized: resolve, onAbort: () => reject(new Error("CONVERSION_FAILED")) };
  self.__filename = base;
  try { importScripts(base + "x2t.js"); runtime = self.Module; }
  catch (error) { reject(error); }
});
self.onmessage = async (event) => {
  const { bytes, extension } = event.data || {};
  if (!(bytes instanceof ArrayBuffer) || !/^(docx?|xlsx?|pptx?|od[tpst]|rtf|wps|et|dps)$/.test(extension || "")) return;
  try {
    await ready;
    const fs = runtime.FS;
    ["/working", "/working/media", "/working/fonts", "/working/themes"].forEach((dir) => fs.mkdir(dir));
    const input = "/working/doc." + extension, output = "/working/Editor.bin";
    fs.writeFile(input, new Uint8Array(bytes));
    const convert = (from, to) => {
      fs.writeFile("/working/params.xml", '<?xml version="1.0" encoding="utf-8"?><TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><m_sFileFrom>' + from + '</m_sFileFrom><m_sThemeDir>/working/themes</m_sThemeDir><m_sFileTo>' + to + '</m_sFileTo><m_bIsNoBase64>false</m_bIsNoBase64><m_sFontDir>/working/fonts/</m_sFontDir></TaskQueueDataConvert>');
      if (runtime.ccall("main1", "number", ["string"], ["/working/params.xml"]) !== 0) throw new Error("CONVERSION_FAILED");
    };
    if (extension === "doc") { convert(input, input + "x"); convert(input + "x", output); }
    else convert(input, output);
    const binary = fs.readFile(output), media = {};
    if (!binary?.byteLength) throw new Error("CONVERSION_FAILED");
    for (const name of fs.readdir("/working/media")) {
      if (name === "." || name === ".." || !/^[a-zA-Z0-9_.-]+$/.test(name)) continue;
      media["media/" + name] = fs.readFile("/working/media/" + name);
    }
    self.postMessage({ type: "converted", binary, media }, [binary.buffer, ...Object.values(media).map((value) => value.buffer)]);
  } catch { self.postMessage({ type: "error" }); }
};
