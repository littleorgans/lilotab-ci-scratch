// The platform the page runs on, for the list keys' modifier: Cmd on macOS, Ctrl elsewhere (C-SRCH-25, C-SRCH-26).

// userAgentData is Chromium only and missing from the DOM types; navigator.platform is the fallback.
type UaNavigator = Navigator & { userAgentData?: { platform: string } };

export const isMac = (): boolean =>
  /^mac/i.test((navigator as UaNavigator).userAgentData?.platform ?? navigator.platform);
