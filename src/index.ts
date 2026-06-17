import { Worker } from "@notionhq/workers";
import { registerFancyHtml } from "./fancyhtml";

const worker = new Worker();
export default worker;

// Register the fancyhtml tool on the shared worker.
registerFancyHtml(worker);
