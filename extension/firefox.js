browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle().catch(console.error);
});
