import { app } from "./app.js";

const port = Number(process.env.PORT ?? 4002);

app.listen(port, () => {
  console.log(`Accounting / General Ledger module listening on :${port}`);
});
