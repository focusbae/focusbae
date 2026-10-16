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
  const params = new URL(location.href).searchParams;
  const inputs = async () =>
    (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "audioinput",
    );
  // Listing names the microphones for the picker without opening any of them.
  if (params.get("list") === "1") {
    try {
      const names = (await inputs())
        .filter((device) => device.deviceId !== "default" && device.label)
        .map((device) => ({ name: device.label, builtIn: /\(Built-in\)$/.test(device.label) }));
      window.localMicrophone.send({ devices: names });
    } catch {
      window.localMicrophone.send({ devices: [] });
    }
    return;
  }
  // A chosen microphone is matched by name: Chromium's device ids differ for every
  // capture window. "fallback" opens the Mac's built-in microphone, for when the
  // default (a Bluetooth headset still waking up) supplies nothing.
  const prefer = params.get("prefer");
  const fallback = params.get("fallback") === "1";
  try {
    const available = await inputs().catch(() => []);
    const chosen = available.find((device) =>
      device.deviceId !== "default" &&
      (fallback ? /\(Built-in\)$/.test(device.label) : !!prefer && device.label === prefer));
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(chosen ? { deviceId: { exact: chosen.deviceId } } : {}),
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
    // A device being added or removed only matters when it changes the input this
    // capture uses: AirPods connecting become the Mac's default input, and the
    // recorder then reopens the microphone on it. A monitor or keyboard with a
    // speaker appearing is ignored. Reporting is left to the main process, which
    // keeps the same recording going.
    // A chosen microphone is kept until it disappears; otherwise the capture
    // follows the Mac's default input.
    const [track] = stream.getAudioTracks();
    const { deviceId, groupId } = track.getSettings();
    // Chromium names the default input "Default - <name>"; keep the device's name.
    window.localMicrophone.send({ device: track.label.replace(/^Default - /, "") || null });
    const inputGroup = async () => {
      const list = await inputs();
      return (chosen ? list.find((device) => device.deviceId === deviceId)
        : list.find((device) => device.deviceId === "default") ??
          list.find((device) => device.deviceId === deviceId))?.groupId;
    };
    const initialGroup = await inputGroup().catch(() => groupId);
    navigator.mediaDevices.addEventListener("devicechange", async () => {
      const current = await inputGroup().catch(() => null);
      if (track.readyState === "ended" || current !== initialGroup) fail();
    });
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
