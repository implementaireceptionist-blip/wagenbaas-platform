const WebSocket = require("ws");

const base = process.env.VOICE_WS_URL || "ws://localhost:3002/api/voice/stream";

const ws = new WebSocket(base);

ws.on("open", () => {
  console.log("connected");
  ws.send(JSON.stringify({ event: "connected", version: "1.0.0" }));
  ws.send(JSON.stringify({
    event: "start",
    sequence_number: "1",
    start: {
      call_control_id: "test_call_control_id",
      from: "+40752859831",
      to: "+31000000000",
      media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
    },
    stream_id: "test_stream_id",
  }));
  setTimeout(() => {
    ws.send(JSON.stringify({ event: "stop", sequence_number: "2", stop: { call_control_id: "test_call_control_id" }, stream_id: "test_stream_id" }));
    ws.close();
  }, 500);
});

ws.on("message", (d) => console.log("recv:", d.toString()));
ws.on("close", () => console.log("closed"));
ws.on("error", (e) => console.error("error:", e.message));

