// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Kept free of React so the root layout, a server component, can inline it.

export const THEME_KEY = 'ujira-theme';
export const RAIL_KEY = 'ujira-rail';

// Runs before first paint and does what restorePreferences does. A test runs
// both against the same storage and compares the result.
export const PREFERENCES_SCRIPT = `(function(){try{var d=document.documentElement,s=window.localStorage,t=s.getItem('${THEME_KEY}');if(t==='light'||t==='dark')d.dataset.theme=t;if(s.getItem('${RAIL_KEY}')==='collapsed')d.dataset.rail='collapsed'}catch(e){}})();`;
