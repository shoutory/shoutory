// Fixed English with no message ids: it shows when no catalog could be loaded.
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
