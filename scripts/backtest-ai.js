const { getAIReply, extractData, cleanReply } = require("../ai");

async function runCase(name, messages) {
  console.log(`\n=== Case: ${name} ===`);
  const raw = await getAIReply(messages);
  const data = extractData(raw);
  const reply = cleanReply(raw);
  console.log("Reply:\n", reply);
  console.log("Parsed:", JSON.stringify(data, null, 2));
}

(async () => {
  await runCase("NL booking", [
    { role: "user", content: "Hoi, ik wil graag een APK en onderhoud voor mijn auto." },
  ]);

  await runCase("EN price question", [
    { role: "user", content: "Hi, how much is an MOT and can I book for next Tuesday afternoon?" },
  ]);

  await runCase("Callback request", [
    { role: "user", content: "I prefer to talk to a real person, can someone call me?" },
  ]);
})();

