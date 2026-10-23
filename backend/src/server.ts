import { app } from "./app.js";
import { config } from "./config.js";
app.listen(config.port, () => console.log(`kkagung API listening on :${config.port}`));
