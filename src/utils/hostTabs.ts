/**
 * Where a detail page's own tabs (Track List, Tags…) go in a user's saved
 * tab order.
 *
 * `InformationSections` sorts tabs by `tabOrder` and puts anything it doesn't
 * name after the named ones — so a saved order that predates a host tab would
 * push it behind every plugin tab. Each host id the saved order lacks is put
 * where it belongs instead: the first one at the front, each later one right
 * after the host id before it. Ids already in the saved order stay where the
 * user dragged them.
 */
export function withHostTabs(saved: readonly string[], hostIds: readonly string[]): string[] {
  const order = [...saved];
  hostIds.forEach((id, i) => {
    if (order.includes(id)) return;
    const prev = i > 0 ? order.indexOf(hostIds[i - 1]) : -1;
    order.splice(prev + 1, 0, id);
  });
  return order;
}
