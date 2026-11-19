// R377: the one screen with no message ids. It shows when no message catalog could be loaded, so it cannot use one;
// its text is fixed English and it needs no provider. Every other screen takes its copy from the catalogs.
export function CatalogFallback() {
  return (
    <main id="main">
      <h1>Shoutory could not load</h1>
      <p>The language files did not load. Check your connection, then reload the page.</p>
      <button type="button" onClick={() => window.location.reload()}>
        Reload the page
      </button>
    </main>
  );
}
