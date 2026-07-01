import { createApp } from "./http/app.js";
import { loadSettings } from "./config/settings.js";

const settings = loadSettings();
const app = createApp({ settings });

app.listen(settings.port, () => {
  console.log(
    JSON.stringify({
      message: "ai-code-review-agent listening",
      port: settings.port,
      env: settings.appEnv,
    }),
  );
});
