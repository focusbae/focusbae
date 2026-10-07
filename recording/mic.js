"use strict";
(async () => {
  let stream,
    context,
    node,
    stopping = false,
    sequence = 0;
  const fail = () => {
    if (!stopping) window.localMicrophone.send({ error: true });
  };
  window.localMicrophone.onAck(() => node?.port.postMessage("ack"));
  window.localMicrophone.onStop(async () => {
    stopping = true;
    if (node) node.port.postMessage("flush");
    else window.localMicrophone.send({ stopped: true });
  });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (stopping) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    for (const track of stream.getTracks())
      track.addEventListener("ended", fail);
    navigator.mediaDevices.addEventListener("devicechange", fail);
    // Chromium supplies the resampling; the worklet only packs PCM16 batches.
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule("mic-worklet.js");
    if (stopping) {
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
      return;
    }
    node = new AudioWorkletNode(context, "pcm-batch");
    node.port.onmessage = async ({ data }) => {
      if (data === "stopped") {
        stream.getTracks().forEach((track) => track.stop());
        await context.close();
        window.localMicrophone.send({ stopped: true });
      } else if (data === "overflow") fail();
      else
        window.localMicrophone.send({
          sequence: sequence++,
          pcm: new Uint8Array(data),
        });
    };
    const silent = context.createGain();
    silent.gain.value = 0;
    context.createMediaStreamSource(stream).connect(node);
    node.connect(silent).connect(context.destination);
    await context.resume();
    if (context.state !== "running")
      throw new Error("Microphone graph not running");
    context.addEventListener("statechange", () => {
      if (!stopping && context.state !== "running") fail();
    });
  } catch {
    stream?.getTracks().forEach((track) => track.stop());
    await context?.close().catch(() => {});
    fail();
  }
})();
