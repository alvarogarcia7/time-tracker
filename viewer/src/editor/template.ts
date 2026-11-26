// The editor's markup. Static text only; everything shown from files goes in with textContent.
export const EDITOR_TEMPLATE = `
<header class="editor-bar">
  <h1>Day Editor</h1>
  <div class="file-picker">
    <input id="editor-file" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-label="day file" placeholder="type to find a file" autocomplete="off">
    <ul id="file-list" class="suggestions hidden" role="listbox"></ul>
  </div>
  <div class="new-day">
    <input id="new-day" type="date" aria-label="date of a new day">
    <button type="button" id="create-day">New day</button>
  </div>
  <div class="tabs" role="group" aria-label="view">
    <button type="button" id="tab-entries" aria-pressed="true">Entries</button>
    <button type="button" id="tab-plain" aria-pressed="false">Plain text</button>
  </div>
  <button type="button" id="reload">Reload</button>
  <button type="button" id="save" class="primary" disabled>Save</button>
  <div id="status" class="small muted" role="status"></div>
</header>
<div>
  <section id="entries-section">
    <p class="hint muted small">An entry ends where the next line starts. The last entry stays open.</p>
    <div class="filters">
      <label>Category
        <select id="filter-category">
          <option value="all">all</option>
          <option value="categorized">categorized</option>
          <option value="uncategorized">uncategorized</option>
        </select>
      </label>
      <label>Project
        <select id="filter-project">
          <option value="all">all</option>
          <option value="with">with project</option>
          <option value="without">without project</option>
        </select>
      </label>
      <span id="filter-count" class="muted small"></span>
    </div>
    <div id="entries"></div>
  </section>
  <section id="plain" class="hidden">
    <textarea id="plain-text" spellcheck="false" aria-label="day file text"></textarea>
  </section>
</div>
`;
