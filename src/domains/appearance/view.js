/** Dedicated appearance workspace, reusing the validated appearance controls. */
import { settingsView } from "../settings/view.js";

export function appearanceView({state,pageHeading}) {
  return settingsView({state,pageHeading,appearanceOnly:true});
}
