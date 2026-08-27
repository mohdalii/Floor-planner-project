import "dotenv/config";
import { createApp } from "./app.js";
import { connectDB } from "./db.js";

const port = process.env.PORT || 5000;

async function main() {
  await connectDB();

  const app = createApp();

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
