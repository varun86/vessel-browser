// Barrel for the page-actions subdirectory. Re-exports the public
// functions that the outer barrel (`../page-actions.ts`) forwards.

export {
  clickElementBySelector,
  clickResolvedSelector,
  getTabByMatch,
  scrollPage,
  searchPage,
} from "./navigation";
export { clearOverlays, dismissPopup } from "./overlays";
export { isDangerousAction } from "./orchestrator";
export {
  fillFormFields,
  focusElement,
  hoverElement,
  pressKey,
  pressKeyDirect,
  selectOptionDirect,
  setElementValue,
  submitFormBySelector,
  submitFormDirect,
  typeKeystroke,
  waitForConditionDirect,
} from "./interaction";
export { waitForLoad } from "../../utils/webcontents-utils";
