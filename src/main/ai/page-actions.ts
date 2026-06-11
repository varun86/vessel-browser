// Thin re-export barrel for backwards compatibility. New code should
// import directly from `page-actions/<sub-module>` or `page-actions/orchestrator`.

export {
  executeAction,
  clearCartState,
} from "./page-actions/orchestrator";

export { getBookmarkMetadataFromArgs } from "./page-actions/bookmark-metadata";

export {
  TabMutex,
  PAGE_SCRIPT_TIMEOUT,
  pageBusyError,
  executePageScript,
  loadPermittedUrl,
  waitForPotentialNavigation,
  logger,
  type ActionContext,
  type FillFormFieldInput,
  type FillFormFieldResult,
} from "./page-actions/core";

export {
  scrollPage,
  clickResolvedSelector,
  clickElementBySelector,
  clearOverlays,
  dismissPopup,
  searchPage,
  isDangerousAction,
} from "./page-actions/index";

export {
  resolveBookmarkFolderTarget,
  describeFolder,
  composeDuplicateBookmarkResponse,
  composeFolderAwareResponse,
} from "./page-bookmarks";

export {
  fillFormFields,
  focusElement,
  getTabByMatch,
  hoverElement,
  pressKey,
  pressKeyDirect,
  selectOptionDirect,
  setElementValue,
  submitFormBySelector,
  submitFormDirect,
  typeKeystroke,
  waitForConditionDirect,
  waitForLoad,
} from "./page-actions/index";

export {
  normalizeSearchQuery,
  buildCommonSearchUrlShortcut,
  buildSearchShortcut,
} from "./page-actions/navigation";
