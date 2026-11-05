import { connection } from "next/server";
import { ControlConsole } from "@/components/control-console";
import { ControlConsoleV2 } from "@/components/control-console-v2";

export default async function Home() {
  // Keep the legacy panel active until V2 DB/env and Python cutover are ready.
  // The flag is server-only, never exposed to the browser.
  await connection();
  return process.env.ALEXIOS_WEB_V2_ENABLED === "true"
    ? <ControlConsoleV2 />
    : <ControlConsole />;
}
