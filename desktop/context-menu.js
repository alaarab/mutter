// The right-click menu Electron leaves out: Copy on selected chat text, and
// the usual edit actions in text fields. Nothing else gets a menu, so a
// right click on the rest of the window stays free (it can be push-to-talk).
export function contextMenuItems({ isEditable, selectionText, editFlags }) {
  if (isEditable) {
    return [
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll },
    ];
  }
  if (selectionText.trim()) {
    return [{ role: 'copy' }];
  }
  return [];
}
