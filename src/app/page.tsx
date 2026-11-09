import { connection } from "next/server";
import { ControlConsole } from "@/components/control-console";
import { ControlConsoleV2 } from "@/components/control-console-v2";

export default async function Home() {
  await connection();

  // Local development previews the redesigned V2/V3 console by default.
  // An explicit legacy override is still available for comparisons.
  // Production retains the existing opt-in flag and is unchanged by this PR.
  const legacyRequested = process.env.ALEXIOS_WEB_INTERFACE === "legacy";
  const modernRequested = process.env.ALEXIOS_WEB_INTERFACE === "modern";
  const useModernConsole = !legacyRequested && (
    modernRequested ||
    process.env.NODE_ENV === "development" ||
    process.env.ALEXIOS_WEB_V2_ENABLED === "true"
  );

  return useModernConsole ? <ControlConsoleV2 /> : <ControlConsole />;
}
