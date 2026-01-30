/// <reference path="shared.app.js" />

(function () {
  "use strict";

  /** @type {AF} */
  const AF = (window.AF = window.AF || {});
  AF.ui = AF.ui || {};

  // ---------- System Dialogs (replaces alert/confirm/prompt) ----------
  // Lightweight, theme-consistent modal dialog service living in the UI layer.
  // Usage:
  //   await AF.ui.dialog.alert("Hello");
  //   const ok = await AF.ui.dialog.confirm("Continue?");
  //   const name = await AF.ui.dialog.prompt("Name:", "Default");
  //   const res = await AF.ui.dialog.open({ title, message, html, contentEl, buttons, input })
  const dialog = (() => {
    /** @type {HTMLDivElement|null} */
    let dialogEl = null;
    /** @type {HTMLDivElement|null} */
    let bodyEl = null;
    /** @type {HTMLDivElement|null} */
    let footerEl = null;
    /** @type {HTMLHeadingElement|null} */
    let titleEl = null;
    /** @type {HTMLInputElement|null} */
    let inputEl = null;

    /** @type {{ resolve: ((v: any) => void), cancelButtonId?: string, defaultButtonId?: string, closeOnOverlay?: boolean, closeOnEsc?: boolean } | null} */
    let active = null;
    /** @type {((e: KeyboardEvent) => void) | null} */
    let activeKeyHandler = null;

    function ensureDialogDom() {
      if (dialogEl && bodyEl && footerEl && titleEl) return;

      dialogEl = document.createElement("div");
      dialogEl.id = "afSystemDialog";
      dialogEl.className = "dialog hidden";

      const overlay = document.createElement("div");
      overlay.className = "dialog__overlay";

      const content = document.createElement("div");
      content.className = "dialog__content";
      content.setAttribute("role", "dialog");
      content.setAttribute("aria-modal", "true");
      content.setAttribute("aria-labelledby", "afSystemDialogTitle");

      const header = document.createElement("div");
      header.className = "dialog__header";

      titleEl = document.createElement("h2");
      titleEl.className = "dialog__title";
      titleEl.id = "afSystemDialogTitle";

      const closeBtn = document.createElement("button");
      closeBtn.className = "btn btn--sm";
      closeBtn.type = "button";
      closeBtn.textContent = "✕";
      closeBtn.addEventListener("click", () => closeWithButtonId(active?.cancelButtonId ?? "cancel"));

      header.appendChild(titleEl);
      header.appendChild(closeBtn);

      bodyEl = document.createElement("div");
      bodyEl.className = "dialog__body";

      footerEl = document.createElement("div");
      footerEl.className = "dialog__footer";

      content.appendChild(header);
      content.appendChild(bodyEl);
      content.appendChild(footerEl);

      dialogEl.appendChild(overlay);
      dialogEl.appendChild(content);
      document.body.appendChild(dialogEl);

      overlay.addEventListener("click", () => {
        if (!active) return;
        if (active.closeOnOverlay === false) return;
        closeWithButtonId(active.cancelButtonId ?? "cancel");
      });
    }

    function cleanupKeyHandler() {
      if (activeKeyHandler) {
        document.removeEventListener("keydown", activeKeyHandler, true);
        activeKeyHandler = null;
      }
    }

    function closeWithButtonId(buttonId) {
      if (!active) {
        if (dialogEl) dialogEl.classList.add("hidden");
        cleanupKeyHandler();
        return;
      }

      const resolve = active.resolve;
      active = null;
      cleanupKeyHandler();

      if (dialogEl) dialogEl.classList.add("hidden");

      resolve({
        id: buttonId,
        value: inputEl ? inputEl.value : undefined,
      });
    }

    /**
     * @param {{
     *   title?: string,
     *   message?: string,
     *   html?: string,
     *   contentEl?: Element,
     *   input?: { value?: string, placeholder?: string, selectOnOpen?: boolean },
     *   buttons?: Array<{ id: string, label: string, kind?: "primary"|"danger"|"default" }>,
     *   defaultButtonId?: string,
     *   cancelButtonId?: string,
     *   closeOnOverlay?: boolean,
     *   closeOnEsc?: boolean,
     * }} opts
     */
    function open(opts = {}) {
      ensureDialogDom();

      // If something is already open, close it as "cancel" before replacing.
      if (active) closeWithButtonId(active.cancelButtonId ?? "cancel");

      const title = String(opts.title ?? "Notice");
      const buttons = Array.isArray(opts.buttons) && opts.buttons.length > 0
        ? opts.buttons
        : [{ id: "ok", label: "OK", kind: "primary" }];

      if (titleEl) titleEl.textContent = title;
      if (bodyEl) bodyEl.innerHTML = "";
      if (footerEl) footerEl.innerHTML = "";
      inputEl = null;

      if (bodyEl && opts.message) {
        const msg = document.createElement("div");
        msg.style.whiteSpace = "pre-wrap";
        msg.textContent = String(opts.message);
        bodyEl.appendChild(msg);
      }

      if (bodyEl && opts.html) {
        const htmlWrap = document.createElement("div");
        htmlWrap.innerHTML = String(opts.html);
        bodyEl.appendChild(htmlWrap);
      }

      if (bodyEl && opts.contentEl) {
        bodyEl.appendChild(opts.contentEl);
      }

      if (bodyEl && opts.input) {
        const field = document.createElement("div");
        field.className = "field";

        inputEl = document.createElement("input");
        inputEl.className = "input";
        inputEl.type = "text";
        inputEl.value = String(opts.input.value ?? "");
        inputEl.placeholder = String(opts.input.placeholder ?? "");

        field.appendChild(inputEl);
        bodyEl.appendChild(field);
      }

      const p = new Promise((resolve) => {
        active = {
          resolve,
          cancelButtonId: opts.cancelButtonId,
          defaultButtonId: opts.defaultButtonId,
          closeOnOverlay: opts.closeOnOverlay !== false,
          closeOnEsc: opts.closeOnEsc !== false,
        };
      });

      // Render buttons
      let defaultBtn = null;
      buttons.forEach((b) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn";
        if (b.kind === "primary") btn.classList.add("btn--primary");
        if (b.kind === "danger") btn.classList.add("btn--danger");
        btn.textContent = String(b.label);
        btn.addEventListener("click", () => closeWithButtonId(b.id));
        footerEl?.appendChild(btn);
        if (b.id === (opts.defaultButtonId ?? "ok")) defaultBtn = btn;
      });

      // Keyboard handling
      activeKeyHandler = (e) => {
        if (!active) return;

        if (e.key === "Escape") {
          if (active.closeOnEsc === false) return;
          e.preventDefault();
          closeWithButtonId(active.cancelButtonId ?? "cancel");
          return;
        }

        if (e.key === "Enter") {
          const tag = (document.activeElement?.tagName || "").toLowerCase();
          if (tag === "textarea") return;
          if (defaultBtn) {
            e.preventDefault();
            defaultBtn.click();
          }
        }
      };
      document.addEventListener("keydown", activeKeyHandler, true);

      dialogEl?.classList.remove("hidden");

      // Focus management
      setTimeout(() => {
        if (inputEl) {
          inputEl.focus();
          if (opts.input?.selectOnOpen !== false) inputEl.select();
        } else if (defaultBtn) {
          defaultBtn.focus();
        }
      }, 0);

      return p;
    }

    /**
     * @param {string} message
     * @param {{ title?: string, okText?: string }=} opts
     */
    async function alert(message, opts = {}) {
      await open({
        title: opts.title ?? "Notice",
        message,
        buttons: [{ id: "ok", label: opts.okText ?? "OK", kind: "primary" }],
        defaultButtonId: "ok",
        cancelButtonId: "ok",
      });
    }

    /**
     * @param {string} message
     * @param {{ title?: string, okText?: string, cancelText?: string, danger?: boolean }=} opts
     * @returns {Promise<boolean>}
     */
    async function confirm(message, opts = {}) {
      const res = await open({
        title: opts.title ?? "Confirm",
        message,
        buttons: [
          { id: "cancel", label: opts.cancelText ?? "Cancel", kind: "default" },
          { id: "ok", label: opts.okText ?? "OK", kind: opts.danger ? "danger" : "primary" },
        ],
        defaultButtonId: "ok",
        cancelButtonId: "cancel",
      });
      return res?.id === "ok";
    }

    /**
     * @param {string} message
     * @param {string=} defaultValue
     * @param {{ title?: string, okText?: string, cancelText?: string, placeholder?: string }=} opts
     * @returns {Promise<string|null>}
     */
    async function prompt(message, defaultValue = "", opts = {}) {
      const res = await open({
        title: opts.title ?? "Input",
        message,
        input: { value: defaultValue ?? "", placeholder: opts.placeholder ?? "", selectOnOpen: true },
        buttons: [
          { id: "cancel", label: opts.cancelText ?? "Cancel", kind: "default" },
          { id: "ok", label: opts.okText ?? "OK", kind: "primary" },
        ],
        defaultButtonId: "ok",
        cancelButtonId: "cancel",
      });
      if (!res || res.id !== "ok") return null;
      const v = String(res.value ?? "").trim();
      return v ? v : null;
    }

    function close() {
      closeWithButtonId(active?.cancelButtonId ?? "cancel");
    }

    return { open, alert, confirm, prompt, close };
  })();

  AF.ui.dialog = dialog;


  // Export UI init for app.js orchestrator
  function init() {
    wireMenus();
    wireTabs();
    wireWorkspaceTabs();
    wireSearch();
    wireAddButtons();
    wireListsAndForms();
    wireImportInput();
    wireBuildImportInput();
    wireCanvas();
  }

  function wireMenus() {
    const onDocClick = (e) => {
      const menuBtn = e.target.closest?.("[data-menu]");
      if (menuBtn) {
        toggleMenu(menuBtn.dataset.menu);
        return;
      }

      const dropdownItem = e.target.closest?.("[data-action]");
      if (dropdownItem && dropdownItem.getAttribute("role") === "menuitem") {
        void handleAction(dropdownItem.dataset.action);
        closeAllMenus();
        return;
      }

      // Click outside closes menus
      closeAllMenus();
    };

    document.addEventListener("click", onDocClick);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllMenus();
    });
  }

  function toggleMenu(name) {
    const btn = document.querySelector(`[data-menu="${name}"]`);
    const dd = document.querySelector(`[data-menu-dropdown="${name}"]`);
    if (!btn || !dd) return;
    const isOpen = btn.getAttribute("aria-expanded") === "true";
    closeAllMenus();
    if (!isOpen) {
      btn.setAttribute("aria-expanded", "true");
      dd.style.display = "block";
    }
  }

  function closeAllMenus() {
    $$("[data-menu]").forEach((b) => b.setAttribute("aria-expanded", "false"));
    $$("[data-menu-dropdown]").forEach((dd) => (dd.style.display = "none"));
  }

  function wireTabs() {
    $$(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        AF.state.ui.activeTab = btn.dataset.tab;
        renderTabs();
      });
    });
  }

  function wireWorkspaceTabs() {
    const bar = $("#workspaceTabsBar");
    if (!bar) return;

    // Double-click a tab to rename it.
    bar.addEventListener("dblclick", async (e) => {
      if (e.target.closest?.('[data-action="workspace:close"]')) return;
      const tabBtn = e.target.closest?.("[data-workspace-id]");
      if (!tabBtn) return;
      await handleAction("workspace:rename-tab", { workspaceId: tabBtn.dataset.workspaceId });
    });
  }

  function wireSearch() {
    $("#materialSearch")?.addEventListener("input", (e) => {
      AF.state.ui.filters.materials = e.target.value;
      renderMaterials();
    });
    $("#machineSearch")?.addEventListener("input", (e) => {
      AF.state.ui.filters.machines = e.target.value;
      renderMachines();
    });
    $("#blueprintSelectionSearch")?.addEventListener("input", (e) => {
      renderBlueprintSelectionList(e.target.value);
    });
  }

  function wireAddButtons() {
    $("#addMaterialBtn")?.addEventListener("click", () => {
      const id = makeId("mat");
      AF.state.db.materials.push({
        id,
        name: "New Material",
        buyPrice: null,
        salePrice: null,
        stackSize: 1,
        isFuel: false,
        fuelValue: null,
        isFertilizer: false,
        fertilizerNutrientValue: null,
        fertilizerMaxFertility: null,
        isPlant: false,
        plantRequiredNutrient: null,
      });
      AF.state.ui.selected.materials = id;
      AF.core.saveDb();
      renderMaterials();
      setStatus("Material added.");
    });

    $("#addMachineBtn")?.addEventListener("click", () => {
      const id = makeId("mac");
      AF.state.db.machines.push({
        id,
        name: "New Machine",
        inputs: 1,
        outputs: 1,
        requiresFurnace: false,
        heatConsumptionP: null,
        kind: "standard",
        baseHeatConsumptionP: 1,
      });
      AF.state.ui.selected.machines = id;
      AF.core.saveDb();
      renderMachines();
      setStatus("Machine added.");
    });

  }

  function wireImportInput() {
    const input = $("#importFileInput");
    if (!input) return;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await importDbFromFile(file);
      } catch (err) {
        console.error(err);
        setStatus("Failed to import JSON (invalid file).", "error");
      }
    });
  }

  function wireBuildImportInput() {
    const input = $("#importBuildInput");
    if (!input) return;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await importBuildFromFile(file);
      } catch (err) {
        console.error(err);
        setStatus("Failed to load build JSON (invalid file).", "error");
      }
    });
  }

  function wireListsAndForms() {
    document.addEventListener("click", async (e) => {
      // Handle blueprint edit action buttons in canvas subtitle
      const bpActionBtn = e.target.closest?.("#canvasSubtitle [data-action]");
      if (bpActionBtn) {
        const action = bpActionBtn.dataset.action;
        await handleAction(action);
        return;
      }

      // Handle coordinates click (jump to coordinates)
      const coordsSpan = e.target.closest?.(".canvas__coords");
      if (coordsSpan) {
        openJumpToCoordinatesDialog();
        return;
      }

      // Handle dropdown toggle
      const dropdownToggle = e.target.closest?.("[data-dropdown-toggle]");
      if (dropdownToggle) {
        const kind = dropdownToggle.dataset.dropdownToggle;
        const dropdown = $(`[data-dropdown="${kind}"]`);
        const list = dropdown?.querySelector(".dropdownSelector__list");
        if (dropdown && list) {
          const isOpen = !list.classList.contains("hidden");
          // Close all dropdowns first
          $$(".dropdownSelector__list").forEach(l => l.classList.add("hidden"));
          $$(".dropdownSelector").forEach(d => d.classList.remove("is-open"));
          // Toggle this one
          if (!isOpen) {
            list.classList.remove("hidden");
            dropdown.classList.add("is-open");
          }
        }
        return;
      }

      // Handle recipe card toggle
      const recipeToggle = e.target.closest?.("[data-recipe-toggle]");
      if (recipeToggle) {
        const card = recipeToggle.closest(".recipeCard");
        if (card) {
          const body = card.querySelector(".recipeCard__body");
          if (body) {
            const isOpen = !body.classList.contains("hidden");
            body.classList.toggle("hidden");
            card.classList.toggle("is-open");
          }
        }
        return;
      }

      const listItem = e.target.closest?.(".listItem");
      if (listItem?.dataset?.kind && listItem?.dataset?.id) {
        const { kind, id } = listItem.dataset;
        AF.state.ui.selected[kind] = id;

        // Close the dropdown
        const dropdown = $(`[data-dropdown="${kind}"]`);
        if (dropdown) {
          dropdown.querySelector(".dropdownSelector__list")?.classList.add("hidden");
          dropdown.classList.remove("is-open");
        }

        if (kind === "materials") renderMaterials();
        if (kind === "machines") renderMachines();
        return;
      }

      // Close dropdowns when clicking outside
      if (!e.target.closest?.(".dropdownSelector")) {
        $$(".dropdownSelector__list").forEach(l => l.classList.add("hidden"));
        $$(".dropdownSelector").forEach(d => d.classList.remove("is-open"));
      }

      // Handle storage type selection
      const storageTypeItem = e.target.closest?.("[data-storage-machine-id]");
      if (storageTypeItem) {
        const newMachineId = storageTypeItem.dataset.storageMachineId;

        // Check if we're replacing an existing storage
        const replacementId = AF.state.ui.pendingStorageReplacementId;
        if (replacementId) {
          await replaceStorageType(replacementId, newMachineId);
          closeDialog();
          AF.state.ui.pendingStorageReplacementId = null;
          return;
        }

        // Otherwise, adding new storage to canvas
        const coords = AF.state.ui.pendingStorageCoords;
        if (coords && newMachineId) {
          addStorageToCanvas(coords.x, coords.y, newMachineId);
          closeDialog();
          AF.state.ui.pendingStorageCoords = null;
        }
        return;
      }

      // Handle blueprint selection
      const blueprintSelectItem = e.target.closest?.("[data-blueprint-select-id]");
      if (blueprintSelectItem) {
        const blueprintId = blueprintSelectItem.dataset.blueprintSelectId;
        const coords = AF.state.ui.pendingBlueprintCoords;
        if (coords && blueprintId) {
          placeBlueprintOnCanvas(blueprintId, coords.x, coords.y);
          closeDialog();
          AF.state.ui.pendingBlueprintCoords = null;
        }
        return;
      }

      // Handle dialog actions (like save buttons in dialogs)
      const dialogAction = e.target.closest?.("[data-action]");
      if (dialogAction && dialogAction.closest(".dialog")) {
        await handleAction(dialogAction.dataset.action);
        return;
      }

      const actionBtn = e.target.closest?.("[data-action]");
      if (!actionBtn) return;

      // Skip menu items - they're handled by wireMenus()
      if (actionBtn.getAttribute("role") === "menuitem") return;

      const action = actionBtn.dataset.action;
      await handleAction(action, actionBtn.dataset);
    });

    document.addEventListener("change", (e) => {
      // Machine kind selection - show/hide relevant sections
      const machineForm = e.target.closest?.('form[data-form="machine"]');
      if (machineForm && e.target.name === "kind") {
        const heatingDeviceSection = machineForm.querySelector("[data-heating-device-section]");
        const stdSection = machineForm.querySelector("[data-standard-section]");
        const storageSection = machineForm.querySelector("[data-storage-section]");

        const kind = e.target.value;
        const isHeatingDevice = kind === "heating_device";
        const isStorage = kind === "storage";

        heatingDeviceSection?.classList.toggle("hidden", !isHeatingDevice);
        storageSection?.classList.toggle("hidden", !isStorage);
        stdSection?.classList.toggle("hidden", isHeatingDevice || isStorage);
      }
      if (machineForm && e.target.name === "requiresFurnace") {
        const heat = machineForm.querySelector('input[name="heatConsumptionP"]');
        if (heat) heat.disabled = !e.target.checked;
      }

      // Material type checkboxes - mutually exclusive and show/hide fields
      const materialForm = e.target.closest?.('form[data-form="material"]');
      if (materialForm && (e.target.name === "isFuel" || e.target.name === "isFertilizer" || e.target.name === "isPlant")) {
        const fuelCheckbox = materialForm.querySelector('[name="isFuel"]');
        const fertilizerCheckbox = materialForm.querySelector('[name="isFertilizer"]');
        const plantCheckbox = materialForm.querySelector('[name="isPlant"]');
        const fertilizerFields = materialForm.querySelector('[data-fertilizer-fields]');
        const plantField = materialForm.querySelector('[data-plant-field]');

        // Enforce mutual exclusivity
        if (e.target.checked) {
          if (e.target.name === "isFuel") {
            fertilizerCheckbox.checked = false;
            plantCheckbox.checked = false;
          } else if (e.target.name === "isFertilizer") {
            fuelCheckbox.checked = false;
            plantCheckbox.checked = false;
          } else if (e.target.name === "isPlant") {
            fuelCheckbox.checked = false;
            fertilizerCheckbox.checked = false;
          }
        }

        // Show/hide fields based on checkboxes
        if (fertilizerFields) {
          fertilizerFields.style.display = fertilizerCheckbox.checked ? "" : "none";
        }
        if (plantField) {
          plantField.style.display = plantCheckbox.checked ? "" : "none";
        }
      }

      // Recipe machine selection: auto-populate inputs/outputs
      const recipeForm = e.target.closest?.('form[data-form="recipe"]');
      if (recipeForm && e.target.name === "machineId") {
        const recipeId = recipeForm.dataset.id;
        if (!recipeId) return;
        const recipe = AF.core?.getRecipeById(recipeId);
        if (!recipe) return;

        // Update recipe's machineId immediately (don't save yet)
        recipe.machineId = e.target.value;

        // Get the new machine's input/output counts
        const machine = AF.core?.getMachineById(e.target.value);
        const numInputs = machine ? machine.inputs : 1;
        const numOutputs = machine ? machine.outputs : 1;

        // Resize inputs/outputs arrays
        while (recipe.inputs.length < numInputs) recipe.inputs.push({ materialId: "", items: 0 });
        while (recipe.inputs.length > numInputs) recipe.inputs.pop();
        while (recipe.outputs.length < numOutputs) recipe.outputs.push({ materialId: "", items: 0 });
        while (recipe.outputs.length > numOutputs) recipe.outputs.pop();

        // Re-render only the I/O rows, not the entire form
        const processingTimeSec = parseTimeString(recipeForm.querySelector('[data-bind="processingTimeSec"]')?.value) || 0;

        const inputsList = recipeForm.querySelector('[data-io-list="inputs"]');
        const outputsList = recipeForm.querySelector('[data-io-list="outputs"]');

        if (inputsList) {
          inputsList.innerHTML = "";
          recipe.inputs.forEach((io, idx) => {
            const row = renderIoRowElement("inputs", idx, io, processingTimeSec);
            inputsList.appendChild(row);
          });
        }

        if (outputsList) {
          outputsList.innerHTML = "";
          recipe.outputs.forEach((io, idx) => {
            const row = renderIoRowElement("outputs", idx, io, processingTimeSec);
            outputsList.appendChild(row);
          });
        }
      }
    });

    document.addEventListener("submit", (e) => {
      const form = e.target.closest?.("form[data-form]");
      if (!form) return;
      e.preventDefault();

      const type = form.dataset.form;
      const id = form.dataset.id;
      if (!type || !id) return;

      if (type === "material") {
        onSaveMaterial(form, id);
        return;
      }
      if (type === "machine") {
        onSaveMachine(form, id);
        return;
      }
      if (type === "recipe") {
        onSaveRecipe(form, id);
      }
    });
  }

  async function handleAction(action, data = {}) {
    switch (action) {
      case "workspace:new": {
        const tab = AF.core?.createWorkspaceTab?.({ name: "", switchTo: true });
        renderWorkspaceTabsUI();
        if (tab) setStatus(`Created tab: "${tab.name}".`, "success");
        return;
      }
      case "workspace:switch": {
        const id = data.workspaceId;
        if (!id) return;
        const ok = AF.core?.switchWorkspaceTab?.(id);
        if (ok) {
          renderWorkspaceTabsUI();
        }
        return;
      }
      case "workspace:close": {
        const id = data.workspaceId;
        if (!id) return;
        const tab = (AF.state.workspaces?.tabs || []).find(t => t.id === id) || null;
        if (!tab) return;

        const ok = await AF.ui.dialog.confirm(
          `Close "${tab.name}"?\n\nThis will remove this production workspace and its canvas state from your browser.`,
          { title: "Close tab", danger: true, okText: "Close", cancelText: "Cancel" }
        );
        if (!ok) return;

        const closed = AF.core?.closeWorkspaceTab?.(id);
        if (!closed) {
          await AF.ui.dialog.alert("You must keep at least one workspace tab open.", { title: "Cannot close tab" });
          return;
        }
        renderWorkspaceTabsUI();
        setStatus(`Closed tab: "${tab.name}".`, "info");
        return;
      }
      case "workspace:rename": {
        const active = AF.core?.getActiveWorkspaceTab?.();
        if (!active) return;
        const name = await AF.ui.dialog.prompt("Rename this production workspace:", active.name, { title: "Rename tab" });
        if (!name) return;
        AF.core?.renameWorkspaceTab?.(active.id, name);
        renderWorkspaceTabsUI();
        setStatus(`Renamed tab to "${name}".`, "success");
        return;
      }
      case "workspace:rename-tab": {
        const id = data.workspaceId;
        if (!id) return;
        const tab = (AF.state.workspaces?.tabs || []).find(t => t.id === id) || null;
        if (!tab) return;
        const name = await AF.ui.dialog.prompt("Rename this production workspace:", tab.name, { title: "Rename tab" });
        if (!name) return;
        AF.core?.renameWorkspaceTab?.(id, name);
        renderWorkspaceTabsUI();
        setStatus(`Renamed tab to "${name}".`, "success");
        return;
      }
      case "file:new": {
        const ok = await AF.ui.dialog.confirm(
          "This will clear the local database stored in your browser. Continue?",
          { title: "Clear database", danger: true }
        );
        if (ok) AF.core?.clearDb?.();
        return;
      }
      case "file:export":
        AF.core?.exportDb?.();
        return;
      case "file:export-full":
        AF.core?.exportFullState?.();
        return;
      case "file:export-build":
        AF.core?.exportBuildState?.();
        return;
      case "file:load-build": {
        const input = $("#importBuildInput");
        if (!input) return;
        input.value = "";
        input.click();
        return;
      }
      case "file:import": {
        const input = $("#importFileInput");
        if (!input) return;
        input.value = "";
        input.click();
        return;
      }
      case "file:validate":
        validateCurrentBuild();
        return;
      case "file:cost-settings":
        openCostSettingsDialog();
        return;
      case "file:clear-build": {
        const ok = await AF.ui.dialog.confirm(
          "Clear all machines and connections from the build canvas?",
          { title: "Clear build canvas", danger: true }
        );
        if (ok) {
          AF.state.build.placedMachines = [];
          AF.state.build.connections = [];
          AF.state.build.selectedMachines = [];
          AF.core?.saveBuild?.();
          AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: true });
          setStatus("Build canvas cleared.");
        }
        return;
      }
      case "edit:skills":
        openSkillsDialog();
        return;
      case "dialog:close":
        closeDialog();
        return;
      case "skills:save":
        saveSkillsFromDialog();
        return;
      case "settings:save-cost":
        saveCostSettingsFromDialog();
        return;
      case "canvas:toggle-production":
        toggleProductionSidebar();
        return;
      case "canvas:reset-camera":
        AF.state.build.camera = { x: 0, y: 0, zoom: 1.0 };
        AF.core?.saveBuild?.();
        AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: false });
        setStatus("Camera reset to origin.");
        return;
      case "canvas:center-all":
        centerAllMachinesAtOrigin();
        return;
      case "canvas:jump-to-coords":
        jumpToCoordinates();
        return;
      case "sidebar:toggle-database":
        toggleDatabaseSidebar();
        return;
      case "sidebar:toggle-blueprints":
        toggleBlueprintsSidebar();
        return;
      case "blueprint:create":
        openCreateBlueprintDialog();
        return;
      case "blueprint:save":
        saveBlueprintFromDialog();
        return;
      case "blueprint:delete":
        await deleteBlueprint(data.blueprintDeleteId);
        return;
      case "blueprint:add-items-to-canvas":
        addBlueprintItemsToCanvas(data.blueprintAddItemsId);
        return;
      case "blueprint:edit-as-copy":
        enterBlueprintEditModeAsCopyFromSidebar(data.blueprintEditCopyId);
        return;
      case "blueprint:save-edit":
        await saveBlueprintEdit();
        return;
      case "blueprint:save-to-instance":
        await saveBlueprintToInstanceOnly();
        return;
      case "blueprint:save-as-new":
        await saveBlueprintAsNew();
        return;
      case "blueprint:exit-edit":
        await exitBlueprintEditMode();
        return;
      case "storage:save-manual":
        saveManualStorageMaterial();
        return;
      case "heating:save-topper":
        await saveTopperFromDialog();
        return;
      case "material:delete":
        await deleteSelected("materials");
        return;
      case "material:add-recipe":
        addRecipeForMaterial();
        return;
      case "machine:delete":
        await deleteSelected("machines");
        return;
      case "machine:add-to-canvas":
        const machineId = AF.state.ui.selected.machines;
        if (machineId) addMachineToCanvas(machineId);
        return;
      case "recipe:delete":
        await deleteRecipe(data.recipeId);
        return;
      // recipe:add-io and recipe:remove-io no longer needed (auto-populated by machine)
      default:
        return;
    }
  }

  function validateCurrentBuild() {
    const issues = AF.core.validateBuild(AF.state.build.placedMachines, AF.state.build.connections);
    if (issues.length === 0) {
      void AF.ui.dialog.alert("✅ No validation issues found!\n\nYour build is valid.", { title: "Build validation" });
      console.log('✅ Build validation passed - no issues found');
    } else {
      showValidationWarning(issues, 'current build');
      console.group('🔍 Build Validation Issues');
      issues.forEach(issue => {
        console.warn(issue.message, issue);
      });
      console.groupEnd();
    }
  }

  // ---------- Boot ----------

  // ---------- Canvas / Build System ----------

  function wireCanvas() {
    const canvas = $("#designCanvas");
    if (!canvas) return;

    let contextMenu = null;
    let rightClickStartPos = null; // Track right-click start position for context menu vs pan detection

    // Debounced save and sync for zoom
    let zoomSaveTimer = null;

    // Mouse wheel zoom
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();

      const zoomSensitivity = 0.001;
      const minZoom = 0.1;
      const maxZoom = 1.0;

      // Calculate new zoom level
      const delta = -e.deltaY;
      let newZoom = AF.state.build.camera.zoom + (delta * zoomSensitivity);
      newZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));

      if (newZoom !== AF.state.build.camera.zoom) {
        // Get mouse position in world coordinates before zoom
        const canvasRect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - canvasRect.left;
        const mouseY = e.clientY - canvasRect.top;
        const worldPosBefore = screenToWorld(mouseX, mouseY);

        // Apply zoom
        AF.state.build.camera.zoom = newZoom;

        // Get mouse position in world coordinates after zoom
        const worldPosAfter = screenToWorld(mouseX, mouseY);

        // Adjust camera position to keep world position under mouse the same
        AF.state.build.camera.x += worldPosBefore.x - worldPosAfter.x;
        AF.state.build.camera.y += worldPosBefore.y - worldPosAfter.y;

        // Just update the transform, don't re-render
        AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: false });

        // Debounced save and sync (wait for zoom to finish)
        if (zoomSaveTimer) clearTimeout(zoomSaveTimer);
        zoomSaveTimer = setTimeout(() => {
          AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: false });
          AF.core?.saveBuild?.();
        }, 300);
      }
    }, { passive: false });

    // Right-click: track start for pan vs context menu
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 2) { // Right mouse button
        rightClickStartPos = { x: e.clientX, y: e.clientY };
        e.preventDefault();
      }
    });

    // Right-click context menu (only if no drag occurred)
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();

      // Check if this was a drag (moved more than 5 pixels)
      if (rightClickStartPos) {
        const dragDistance = Math.sqrt(
          Math.pow(e.clientX - rightClickStartPos.x, 2) +
          Math.pow(e.clientY - rightClickStartPos.y, 2)
        );

        if (dragDistance > 5) {
          // Was a drag, don't show context menu
          rightClickStartPos = null;
          return;
        }
      }

      rightClickStartPos = null;

      // Remove existing context menu
      if (contextMenu) contextMenu.remove();

      // Create context menu
      contextMenu = document.createElement("div");
      contextMenu.className = "contextMenu";
      contextMenu.style.left = `${e.clientX}px`;
      contextMenu.style.top = `${e.clientY}px`;
      contextMenu.innerHTML = `
        <button class="contextMenu__item" data-action="canvas:add-machine">
          <span>+ Add Machine</span>
        </button>
        <button class="contextMenu__item" data-action="canvas:add-portal">
          <span>+ Add Purchasing Portal</span>
        </button>
        <button class="contextMenu__item" data-action="canvas:add-nursery">
          <span>+ Add Nursery</span>
        </button>
        <button class="contextMenu__item" data-action="canvas:add-storage">
          <span>+ Add Storage</span>
        </button>
        <button class="contextMenu__item" data-action="canvas:add-export">
          <span>📦 Add Export</span>
        </button>
        <button class="contextMenu__item" data-action="canvas:add-blueprint">
          <span>📐 Add Blueprint</span>
        </button>
      `;
      document.body.appendChild(contextMenu);

      // Store click position for machine placement (in world coordinates)
      const canvasRect = canvas.getBoundingClientRect();
      const screenX = e.clientX - canvasRect.left;
      const screenY = e.clientY - canvasRect.top;
      const worldPos = screenToWorld(screenX, screenY);
      contextMenu.dataset.x = String(worldPos.x);
      contextMenu.dataset.y = String(worldPos.y);

      // Close context menu on any click
      setTimeout(() => {
        const closeMenu = (evt) => {
          if (!contextMenu.contains(evt.target)) {
            contextMenu.remove();
            contextMenu = null;
            document.removeEventListener("click", closeMenu);
          }
        };
        document.addEventListener("click", closeMenu);
      }, 0);
    });

    // Handle context menu actions
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-action='canvas:add-machine']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          addBlankMachineToCanvas(x, y);
          menu.remove();
        }
      }
      if (e.target.closest("[data-action='canvas:add-export']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          addExportNodeToCanvas(x, y);
          menu.remove();
        }
      }
      if (e.target.closest("[data-action='canvas:add-storage']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          openStorageSelectionDialog(x, y);
          menu.remove();
        }
      }
      if (e.target.closest("[data-action='canvas:add-portal']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          addPurchasingPortalToCanvas(x, y);
          menu.remove();
        }
      }
      if (e.target.closest("[data-action='canvas:add-nursery']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          addNurseryToCanvas(x, y);
          menu.remove();
        }
      }
      if (e.target.closest("[data-action='canvas:add-blueprint']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          openBlueprintSelectionDialog(x, y);
          menu.remove();
        }
      }
    });

    // Blueprint drag and drop
    canvas.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });

    canvas.addEventListener("drop", (e) => {
      e.preventDefault();
      const blueprintId = e.dataTransfer.getData("blueprintId");
      if (blueprintId) {
        // Calculate drop position in world coordinates
        const canvasRect = canvas.getBoundingClientRect();
        const screenX = e.clientX - canvasRect.left;
        const screenY = e.clientY - canvasRect.top;
        const worldPos = screenToWorld(screenX, screenY);

        placeBlueprintOnCanvas(blueprintId, worldPos.x, worldPos.y);
      }
    });

    // Mouse down - start dragging or connection or panning or selection
    canvas.addEventListener("mousedown", (e) => {
      // Right button = pan camera
      if (e.button === 2) {
        AF.state.ui.dragState = {
          type: "pan",
          startX: e.clientX,
          startY: e.clientY,
          startCamX: AF.state.build.camera.x,
          startCamY: AF.state.build.camera.y,
        };
        canvas.style.cursor = "grabbing";
        e.preventDefault();
        return;
      }

      // Left button - check if starting a connection from output port
      const outputPort = e.target.closest("[data-output-port]");
      if (outputPort) {
        const machineEl = outputPort.closest("[data-placed-machine]");
        const machineId = machineEl.dataset.placedMachine;
        const portIdx = outputPort.dataset.outputPort; // Keep as string to support topper ports

        // Get world coordinates for the port
        const machineData = AF.state.build.placedMachines.find(pm => pm.id === machineId);
        if (!machineData) return;

        const portRect = outputPort.getBoundingClientRect();
        const machineRect = machineEl.getBoundingClientRect();
        const { zoom } = AF.state.build.camera;

        // Calculate port offset within machine card
        const portOffsetX = (portRect.left - machineRect.left + portRect.width) / zoom;
        const portOffsetY = (portRect.top - machineRect.top + portRect.height / 2) / zoom;

        // World coordinates
        const worldX = machineData.x + portOffsetX;
        const worldY = machineData.y + portOffsetY;

        AF.state.ui.dragState = {
          type: "connection",
          fromMachineId: machineId,
          fromPortIdx: portIdx,
          startX: worldX,
          startY: worldY,
        };

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Ignore if clicking on other interactive elements
      if (e.target.closest("select, button, input, [data-input-port]")) {
        return;
      }

      const machineCard = e.target.closest("[data-placed-machine]");

      if (machineCard) {
        // Clicked on a machine card
        const machineId = machineCard.dataset.placedMachine;
        const pm = AF.state.build.placedMachines.find(m => m.id === machineId);
        if (!pm) return;

        // Handle Ctrl+click for multi-selection
        if (e.ctrlKey || e.metaKey) {
          // Toggle selection
          if (AF.state.build.selectedMachines.includes(machineId)) {
            AF.state.build.selectedMachines = AF.state.build.selectedMachines.filter(id => id !== machineId);
          } else {
            AF.state.build.selectedMachines.push(machineId);
          }
          updateSelectionClasses();
          e.preventDefault();
          return;
        }

        // If clicking on an already selected machine, prepare for group drag
        const isAlreadySelected = AF.state.build.selectedMachines.includes(machineId);

        // Store initial positions for all selected machines
        const initialPositions = new Map();
        if (isAlreadySelected && AF.state.build.selectedMachines.length > 0) {
          // Group drag - store all selected machine positions
          AF.state.build.selectedMachines.forEach(id => {
            const machine = AF.state.build.placedMachines.find(m => m.id === id);
            if (machine) {
              initialPositions.set(id, { x: machine.x, y: machine.y });
            }
          });
        } else {
          // Single machine drag - select only this one
          AF.state.build.selectedMachines = [machineId];
          initialPositions.set(machineId, { x: pm.x, y: pm.y });
          updateSelectionClasses();
        }

        AF.state.ui.dragState = {
          type: "machine",
          machineIds: Array.from(AF.state.build.selectedMachines), // All machines being dragged
          startX: e.clientX,
          startY: e.clientY,
          initialPositions: initialPositions,
          hasMoved: false,
        };

        e.preventDefault();
      } else {
        // Clicked on empty canvas - start drag-to-select
        const canvasRect = canvas.getBoundingClientRect();
        const screenX = e.clientX - canvasRect.left;
        const screenY = e.clientY - canvasRect.top;
        const worldPos = screenToWorld(screenX, screenY);

        AF.state.ui.dragState = {
          type: "select",
          startX: e.clientX,
          startY: e.clientY,
          startWorldX: worldPos.x,
          startWorldY: worldPos.y,
          currentX: e.clientX,
          currentY: e.clientY,
        };

        e.preventDefault();
      }
    });

    // Mouse move - drag machine, connection preview, selection box, or pan camera
    document.addEventListener("mousemove", (e) => {
      if (!AF.state.ui.dragState) return;

      if (AF.state.ui.dragState.type === "pan") {
        // Pan the camera
        const dx = e.clientX - AF.state.ui.dragState.startX;
        const dy = e.clientY - AF.state.ui.dragState.startY;

        const { zoom } = AF.state.build.camera;

        // Move camera in opposite direction of mouse movement (drag world, not viewport)
        AF.state.build.camera.x = AF.state.ui.dragState.startCamX - (dx / zoom);
        AF.state.build.camera.y = AF.state.ui.dragState.startCamY - (dy / zoom);

        // Just update the transform, don't re-render everything
        AF.render.updateCameraTransform();
        return;
      }

      if (AF.state.ui.dragState.type === "connection") {
        // Convert mouse position to world coordinates for preview line
        const canvasRect = canvas.getBoundingClientRect();
        const screenX = e.clientX - canvasRect.left;
        const screenY = e.clientY - canvasRect.top;
        const worldPos = screenToWorld(screenX, screenY);

        AF.state.ui.dragState.currentX = worldPos.x;
        AF.state.ui.dragState.currentY = worldPos.y;

        // Re-render connections only (for preview line)
        const svgEl = canvas.querySelector("#connectionsSvg");
        if (svgEl) {
          AF.render?.renderConnections?.(svgEl);
        }
        return;
      }

      if (AF.state.ui.dragState.type === "select") {
        // Update selection box
        AF.state.ui.dragState.currentX = e.clientX;
        AF.state.ui.dragState.currentY = e.clientY;

        // Draw selection box
        drawSelectionBox();
        return;
      }

      if (AF.state.ui.dragState.type === "machine") {
        const dx = e.clientX - AF.state.ui.dragState.startX;
        const dy = e.clientY - AF.state.ui.dragState.startY;

        // Consider it a drag if moved more than 3px
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          AF.state.ui.dragState.hasMoved = true;
        }

        if (AF.state.ui.dragState.hasMoved) {
          // Convert screen delta to world delta
          const { zoom } = AF.state.build.camera;
          const worldDx = dx / zoom;
          const worldDy = dy / zoom;

          // Update all selected machines
          AF.state.ui.dragState.machineIds.forEach(machineId => {
            const pm = AF.state.build.placedMachines.find(m => m.id === machineId);
            const initialPos = AF.state.ui.dragState.initialPositions.get(machineId);

            if (pm && initialPos) {
              // Update world position
              pm.x = initialPos.x + worldDx;
              pm.y = initialPos.y + worldDy;

              // Update machine element position directly (faster than full re-render)
              const machineEl = canvas.querySelector(`[data-placed-machine="${machineId}"]`);
              if (machineEl) {
                machineEl.style.left = `${pm.x}px`;
                machineEl.style.top = `${pm.y}px`;
              }
            }
          });

          // Re-render connections only (still need this for connection lines to follow)
          const svgEl = canvas.querySelector("#connectionsSvg");
          if (svgEl) {
            AF.render.renderConnections(svgEl);
          }
        }
      }
    });

    // Mouse up - end dragging or complete connection or pan or selection
    document.addEventListener("mouseup", (e) => {
      if (!AF.state.ui.dragState) return;

      if (AF.state.ui.dragState.type === "pan") {
        // Sync render and save camera position after panning
        canvas.style.cursor = "";
        AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: false });
        AF.core?.saveBuild?.();
        AF.state.ui.dragState = null;
        return;
      }

      if (AF.state.ui.dragState.type === "select") {
        // Complete selection box
        removeSelectionBox();

        // Calculate selection box in world coordinates
        const canvasRect = canvas.getBoundingClientRect();
        const startScreenX = AF.state.ui.dragState.startX - canvasRect.left;
        const startScreenY = AF.state.ui.dragState.startY - canvasRect.top;
        const endScreenX = e.clientX - canvasRect.left;
        const endScreenY = e.clientY - canvasRect.top;

        const startWorld = screenToWorld(startScreenX, startScreenY);
        const endWorld = screenToWorld(endScreenX, endScreenY);

        const minX = Math.min(startWorld.x, endWorld.x);
        const maxX = Math.max(startWorld.x, endWorld.x);
        const minY = Math.min(startWorld.y, endWorld.y);
        const maxY = Math.max(startWorld.y, endWorld.y);

        // Find all machines within selection box
        const selectedIds = [];
        AF.state.build.placedMachines.forEach(pm => {
          const machineEl = document.querySelector(`[data-placed-machine="${pm.id}"]`);
          if (!machineEl) return;

          const width = machineEl.offsetWidth;
          const height = machineEl.offsetHeight;

          // Check if machine intersects with selection box
          const machineRight = pm.x + width;
          const machineBottom = pm.y + height;

          if (pm.x < maxX && machineRight > minX && pm.y < maxY && machineBottom > minY) {
            selectedIds.push(pm.id);
          }
        });

        AF.state.build.selectedMachines = selectedIds;
        AF.state.ui.dragState = null;
        updateSelectionClasses();

        if (selectedIds.length > 0) {
          setStatus(`Selected ${selectedIds.length} machine${selectedIds.length > 1 ? 's' : ''}.`);
        }

        // Set flag to prevent the subsequent click event from clearing selection
        AF.state.ui.justCompletedSelection = true;
        setTimeout(() => {
          AF.state.ui.justCompletedSelection = false;
        }, 0);

        return;
      }

      if (AF.state.ui.dragState.type === "connection") {
        // Check if dropped on an input port
        const inputPort = e.target.closest("[data-input-port]");
        if (inputPort) {
          const machineEl = inputPort.closest("[data-placed-machine]");
          const toMachineId = machineEl.dataset.placedMachine;
          const toPortIdx = inputPort.dataset.inputPort; // Keep as string to support topper ports

          const { fromMachineId, fromPortIdx } = AF.state.ui.dragState;

          // Check if connection already exists
          const existing = AF.state.build.connections.find(
            conn => conn.fromMachineId === fromMachineId &&
              conn.fromPortIdx === fromPortIdx &&
              conn.toMachineId === toMachineId &&
              conn.toPortIdx === toPortIdx
          );

          if (!existing) {
            // Validate material types match
            const fromMachine = AF.core.findMachineInTree(fromMachineId);
            const toMachineForValidation = AF.core.findMachineInTree(toMachineId);

            if (fromMachine && toMachineForValidation) {
              const outputMaterialId = AF.core.getMaterialIdFromPort(fromMachine, fromPortIdx, "output");
              const inputMaterialId = AF.core.getMaterialIdFromPort(toMachineForValidation, toPortIdx, "input");

              if (outputMaterialId && inputMaterialId && outputMaterialId !== inputMaterialId) {
                const outputMaterial = AF.core?.getMaterialById(outputMaterialId);
                const inputMaterial = AF.core?.getMaterialById(inputMaterialId);
                const outputName = outputMaterial ? outputMaterial.name : "Unknown";
                const inputName = inputMaterial ? inputMaterial.name : "Unknown";

                setStatus(`❌ Cannot connect: Output provides ${outputName}, but input needs ${inputName}.`, "error");
                AF.state.ui.dragState = null;
                AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: false });
                return;
              }
            }

            AF.state.build.connections.push({
              id: makeId("conn"),
              fromMachineId,
              fromPortIdx,
              toMachineId,
              toPortIdx,
            });

            // If connecting TO a storage machine, clear its manual inventories
            const toMachine = AF.state.build.placedMachines.find(pm => pm.id === toMachineId);
            if (toMachine) {
              const machine = AF.core?.getMachineById(toMachine.machineId);
              if (machine && machine.kind === "storage" && toMachine.manualInventories) {
                toMachine.manualInventories = [];
              }
            }

            // Check if connecting to a heating device's fuel port - need full re-render
            let needsFullRender = false;
            if (toPortIdx === "fuel") {
              const toMachineDef = toMachine ? AF.core?.getMachineById(toMachine.machineId) : null;
              if (toMachineDef && toMachineDef.kind === "heating_device") {
                needsFullRender = true;
              }
            } else if (toMachine && toMachine.type === "export") {
              needsFullRender = true;
            }

            AF.core?.saveBuild?.();
            setStatus("Connection created.");

            AF.state.ui.dragState = null;
            AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: needsFullRender }); // Force full re-render if connecting fuel
            return;
          }
        }

        AF.state.ui.dragState = null;
        AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: false });
        return;
      }

      if (AF.state.ui.dragState.type === "machine") {
        // If it was just a click (not a drag), selection already handled in mousedown
        if (AF.state.ui.dragState.hasMoved) {
          // Save build after dragging
          AF.core?.saveBuild?.();
        }

        AF.state.ui.dragState = null;
      }
    });

    // ESC key to cancel connection dragging or selection, Delete key to remove selected items
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (AF.state.ui.dragState && AF.state.ui.dragState.type === "connection") {
          AF.state.ui.dragState = null;
          AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: false });
          setStatus("Connection cancelled.");
          return;
        }
        if (AF.state.ui.dragState && AF.state.ui.dragState.type === "select") {
          removeSelectionBox();
          AF.state.ui.dragState = null;
          return;
        }
        // Escape also clears selection if nothing is being dragged
        if (AF.state.build.selectedMachines.length > 0) {
          AF.state.build.selectedMachines = [];
          updateSelectionClasses();
          return;
        }
      }

      // Delete key to remove selected machines or connection
      if (e.key === "Delete") {
        // Ignore if user is typing in an input field
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") {
          return;
        }

        if (AF.state.build.selectedConnection) {
          void deleteConnection(AF.state.build.selectedConnection);
        } else if (AF.state.build.selectedMachines.length > 0) {
          void deleteSelectedMachines();
        }
      }
    });

    // Delegate events for buttons and ports
    canvas.addEventListener("click", (e) => {
      const cloneBtn = e.target.closest("[data-action='build:clone-machine']");
      if (cloneBtn) {
        const machineId = cloneBtn.closest("[data-placed-machine]").dataset.placedMachine;
        clonePlacedMachine(machineId);
        e.stopPropagation();
        return;
      }

      const deleteBtn = e.target.closest("[data-action='build:delete-machine']");
      if (deleteBtn) {
        const machineCard = deleteBtn.closest("[data-placed-machine]");
        const machineId = machineCard.dataset.placedMachine;

        // Check if confirm button already exists
        const existingConfirm = machineCard.querySelector('[data-action="build:confirm-delete"]');

        if (existingConfirm) {
          // Cancel deletion - remove confirm button and show other buttons
          existingConfirm.classList.add('fadeOut');
          setTimeout(() => {
            existingConfirm.remove();
          }, 200);

          // Show other buttons again
          const buttonContainer = deleteBtn.parentElement;
          const otherButtons = buttonContainer.querySelectorAll('button:not([data-action="build:delete-machine"]):not([data-action="build:confirm-delete"])');
          otherButtons.forEach(btn => {
            btn.style.display = '';
          });
        } else {
          // Show confirm button and hide other buttons
          const buttonContainer = deleteBtn.parentElement;
          const confirmBtn = document.createElement('button');
          confirmBtn.className = 'btn btn--success btn--sm buildMachine__confirmDelete';
          confirmBtn.setAttribute('data-action', 'build:confirm-delete');
          confirmBtn.setAttribute('title', 'Confirm Delete');
          confirmBtn.textContent = '✓';
          confirmBtn.style.animation = 'fadeIn 0.2s ease-out';

          // Hide other buttons (edit, clone, etc)
          const otherButtons = buttonContainer.querySelectorAll('button:not([data-action="build:delete-machine"])');
          otherButtons.forEach(btn => {
            btn.style.display = 'none';
          });

          // Insert before delete button
          buttonContainer.insertBefore(confirmBtn, deleteBtn);
        }

        e.stopPropagation();
        return;
      }

      const confirmDeleteBtn = e.target.closest("[data-action='build:confirm-delete']");
      if (confirmDeleteBtn) {
        const machineCard = confirmDeleteBtn.closest("[data-placed-machine]");
        const machineId = machineCard.dataset.placedMachine;
        deletePlacedMachine(machineId);
        e.stopPropagation();
        return;
      }

      const addManualBtn = e.target.closest("[data-action='storage:add-manual']");
      if (addManualBtn) {
        const machineId = addManualBtn.closest("[data-placed-machine]").dataset.placedMachine;
        openManualStorageDialog(machineId);
        e.stopPropagation();
        return;
      }

      const removeManualBtn = e.target.closest("[data-action='storage:remove-manual']");
      if (removeManualBtn) {
        const machineId = removeManualBtn.closest("[data-placed-machine]").dataset.placedMachine;
        const idx = parseInt(removeManualBtn.dataset.manualIdx);
        removeManualStorageMaterial(machineId, idx);
        e.stopPropagation();
        return;
      }

      const changeTypeBtn = e.target.closest("[data-action='storage:change-type']");
      if (changeTypeBtn) {
        const machineId = changeTypeBtn.closest("[data-placed-machine]").dataset.placedMachine;
        openStorageTypeChangeDialog(machineId);
        e.stopPropagation();
        return;
      }

      const addTopperBtn = e.target.closest("[data-action='heating:add-topper']");
      if (addTopperBtn) {
        const machineId = addTopperBtn.closest("[data-placed-machine]").dataset.placedMachine;
        openAddTopperDialog(machineId);
        e.stopPropagation();
        return;
      }

      const removeTopperBtn = e.target.closest("[data-action='heating:remove-topper']");
      if (removeTopperBtn) {
        const machineId = removeTopperBtn.closest("[data-placed-machine]").dataset.placedMachine;
        const idx = parseInt(removeTopperBtn.dataset.topperIdx);
        void removeTopper(machineId, idx);
        e.stopPropagation();
        return;
      }

      const editBlueprintBtn = e.target.closest("[data-action='blueprint:edit']");
      if (editBlueprintBtn) {
        const machineId = editBlueprintBtn.closest("[data-placed-machine]").dataset.placedMachine;
        enterBlueprintEditMode(machineId);
        e.stopPropagation();
        return;
      }

      // Check if clicked on a connection (polyline)
      if (e.target.tagName === "polyline" && e.target.dataset.connectionId) {
        selectConnection(e.target.dataset.connectionId);
        e.stopPropagation();
        return;
      }

      // If clicked on canvas background (not on a machine or connection), deselect
      // Skip if we just completed a drag-to-select operation
      if ((e.target === canvas || e.target.closest("#connectionsSvg")) && !AF.state.ui.justCompletedSelection) {
        AF.state.build.selectedMachines = [];
        AF.state.build.selectedConnection = null;
        updateSelectionClasses();
      }
    });

    // Handle recipe/machine selection changes
    canvas.addEventListener("change", (e) => {
      const recipeSelect = e.target.closest("[data-machine-recipe-select]");
      if (recipeSelect) {
        const machineId = recipeSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const recipeId = recipeSelect.value;
        updatePlacedMachineRecipe(machineId, recipeId);
        return;
      }

      const machineSelect = e.target.closest("[data-machine-select]");
      if (machineSelect) {
        const placedMachineId = machineSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const machineId = machineSelect.value;
        if (machineId) {
          updatePlacedMachineType(placedMachineId, machineId);
        }
        return;
      }

      const countInput = e.target.closest("[data-machine-count]");
      if (countInput) {
        const placedMachineId = countInput.closest("[data-placed-machine]").dataset.placedMachine;
        const count = Math.max(1, Math.min(999, parseInt(countInput.value) || 1));
        updatePlacedMachineCount(placedMachineId, count);
        return;
      }

      const topperRecipeSelect = e.target.closest("[data-topper-recipe-select]");
      if (topperRecipeSelect) {
        const heatingDeviceId = topperRecipeSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const topperIdx = parseInt(topperRecipeSelect.dataset.topperIdx);
        const recipeId = topperRecipeSelect.value || null;
        updateTopperRecipe(heatingDeviceId, topperIdx, recipeId);
        return;
      }

      const portalMaterialSelect = e.target.closest("[data-portal-material-select]");
      if (portalMaterialSelect) {
        const placedMachineId = portalMaterialSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const materialId = portalMaterialSelect.value;
        updatePurchasingPortalMaterial(placedMachineId, materialId);
        return;
      }

      const nurseryPlantSelect = e.target.closest("[data-nursery-plant-select]");
      if (nurseryPlantSelect) {
        const placedMachineId = nurseryPlantSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const plantId = nurseryPlantSelect.value;
        updateNurseryPlant(placedMachineId, plantId);
        return;
      }

      const nurseryFertilizerSelect = e.target.closest("[data-nursery-fertilizer-select]");
      if (nurseryFertilizerSelect) {
        const placedMachineId = nurseryFertilizerSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const fertilizerId = nurseryFertilizerSelect.value;
        updateNurseryFertilizer(placedMachineId, fertilizerId);
        return;
      }

      const heatingFuelSelect = e.target.closest("[data-heating-fuel-select]");
      if (heatingFuelSelect) {
        const placedMachineId = heatingFuelSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const fuelId = heatingFuelSelect.value;
        updateHeatingDevicePreviewFuel(placedMachineId, fuelId);
        return;
      }

      const storageSlotsInput = e.target.closest("[data-storage-slots]");
      if (storageSlotsInput) {
        const placedMachineId = storageSlotsInput.closest("[data-placed-machine]").dataset.placedMachine;
        const slots = Math.max(1, parseInt(storageSlotsInput.value) || 1);
        updateStorageSlots(placedMachineId, slots);
        return;
      }
    });
  }

  // ---------- Sidebar Management ----------

  function toggleDatabaseSidebar() {
    const wasOpen = AF.state.ui.sidebars.database;

    // Clear any pending production summary updates when closing production sidebar
    if (AF.state.ui.productionSummaryDebounceTimer) {
      clearTimeout(AF.state.ui.productionSummaryDebounceTimer);
      AF.state.ui.productionSummaryDebounceTimer = null;
    }

    // Close left sidebars (only one left panel can be open at a time)
    AF.state.ui.sidebars.database = false;
    AF.state.ui.sidebars.blueprints = false;
    $("#databaseSidebar")?.classList.add("hidden");
    $("#blueprintsSidebar")?.classList.add("hidden");

    // If it wasn't open, open it now
    if (!wasOpen) {
      AF.state.ui.sidebars.database = true;
      $("#databaseSidebar")?.classList.remove("hidden");
    }

    // Update grid layout
    updateLayoutGridColumns();

    // Save UI preferences
    AF.core?.saveUIPrefs?.();

    // Update camera transform after layout change (canvas dimensions may have changed)
    setTimeout(() => AF.render.updateCameraTransform(), 0);
  }

  function toggleBlueprintsSidebar() {
    const wasOpen = AF.state.ui.sidebars.blueprints;

    // Clear any pending production summary updates when closing production sidebar
    if (AF.state.ui.productionSummaryDebounceTimer) {
      clearTimeout(AF.state.ui.productionSummaryDebounceTimer);
      AF.state.ui.productionSummaryDebounceTimer = null;
    }

    // Close left sidebars (only one left panel can be open at a time)
    AF.state.ui.sidebars.database = false;
    AF.state.ui.sidebars.blueprints = false;
    $("#databaseSidebar")?.classList.add("hidden");
    $("#blueprintsSidebar")?.classList.add("hidden");

    // If it wasn't open, open it now
    if (!wasOpen) {
      AF.state.ui.sidebars.blueprints = true;
      $("#blueprintsSidebar")?.classList.remove("hidden");
    }

    // Update grid layout
    updateLayoutGridColumns();

    // Save UI preferences
    AF.core?.saveUIPrefs?.();

    // Update camera transform after layout change (canvas dimensions may have changed)
    setTimeout(() => AF.render?.updateCameraTransform?.(), 0);
  }

  /**
   * Update layout grid columns based on which sidebars are open
   */
  function updateLayoutGridColumns() {
    const layout = $(".layout");
    if (!layout) return;

    const leftOpen = AF.state.ui.sidebars.database || AF.state.ui.sidebars.blueprints;
    const rightOpen = AF.state.ui.sidebars.production;

    if (leftOpen && rightOpen) {
      // Both sides open: left panel, canvas, right panel
      layout.style.gridTemplateColumns = "auto 1fr auto";
    } else if (leftOpen && !rightOpen) {
      // Only left panel open: left panel, canvas
      layout.style.gridTemplateColumns = "auto 1fr";
    } else if (!leftOpen && rightOpen) {
      // Only right panel open: canvas, right panel
      layout.style.gridTemplateColumns = "1fr auto";
    } else {
      // No panels open: just canvas
      layout.style.gridTemplateColumns = "1fr";
    }
  }



  function toggleProductionSidebar() {
    const wasOpen = AF.state.ui.sidebars.production;

    // Clear any pending production summary updates
    if (AF.state.ui.productionSummaryDebounceTimer) {
      clearTimeout(AF.state.ui.productionSummaryDebounceTimer);
      AF.state.ui.productionSummaryDebounceTimer = null;
    }

    // Toggle only production sidebar (can coexist with left panels)
    AF.state.ui.sidebars.production = !wasOpen;

    if (AF.state.ui.sidebars.production) {
      $("#productionSidebar")?.classList.remove("hidden");
      // Render production summary immediately when opening
      AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true });
    } else {
      $("#productionSidebar")?.classList.add("hidden");
    }

    // Update grid layout
    updateLayoutGridColumns();

    // Save UI preferences
    AF.core?.saveUIPrefs?.();

    // Update camera transform after layout change (canvas dimensions may have changed)
    setTimeout(() => AF.render.updateCameraTransform(), 0);
  }

  // ---------- Blueprint Management ----------

  function updateCreateBlueprintButton() {
    const btn = $("#createBlueprintBtn");
    if (!btn) return;

    // Enable button only when machines are selected
    if (AF.state.build.selectedMachines.length > 0) {
      btn.disabled = false;
    } else {
      btn.disabled = true;
    }
  }

  function openCreateBlueprintDialog() {
    if (AF.state.build.selectedMachines.length === 0) {
      setStatus("Please select one or more machines to create a blueprint.", "warning");
      return;
    }

    const dialog = $("#createBlueprintDialog");
    if (!dialog) return;

    // Calculate blueprint analysis (blueprints can now contain other blueprints - nesting allowed)
    /** @type {BlueprintAnalysisResult} */
    let analysis;
    try {
      console.log("Starting blueprint analysis...");
      analysis = AF.calculator.analyzeBlueprintMachines(AF.state.build.selectedMachines);
      console.log("Analysis complete:", analysis);
    } catch (err) {
      console.error("Error analyzing blueprint:", err);
      setStatus("Error analyzing blueprint: " + err.message, "error");
      return;
    }

    // Populate included machines list
    const includedEl = $("#blueprintIncludedMachines");
    if (includedEl) {
      // Export nodes are virtual sinks; keep them in the blueprint but don't show them as "machines"
      // in blueprint-related UI.
      includedEl.innerHTML = analysis.machines
        .filter(pm => pm.type !== "export")
        .map(pm => {
        let machineName = "Unknown";

        // Handle special machine types
        if (pm.type === "purchasing_portal") {
          machineName = "Purchasing Portal";
        } else if (pm.type === "nursery") {
          machineName = "Nursery";
        } else if (pm.type === "blueprint" || pm.type === "blueprint_instance") {
          machineName = pm.name || pm.blueprintData?.name || "Blueprint";
        } else {
          const machine = AF.core.getMachineById(pm.machineId);
          machineName = machine ? machine.name : "Unknown";
        }

        return `<div style="padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,.04);">${machineName} ${pm.count > 1 ? `(×${pm.count})` : ''}</div>`;
      }).join('');
    }

    // Populate inputs
    const inputsEl = $("#blueprintInputs");
    if (inputsEl) {
      if (analysis.inputs.length === 0) {
        inputsEl.innerHTML = '<em>No external inputs required</em>';
      } else {
        inputsEl.innerHTML = analysis.inputs.map(input => {
          if (input.kind === "fuel" || (input.materialId == null && input.internalPortIdx === "fuel")) {
            const pStr = Number(input.rate || 0).toFixed(1);
            return `<div>• Fuel: ${pStr}P</div>`;
          }
          const material = AF.core?.getMaterialById(input.materialId);
          const materialName = material ? material.name : "Unknown";
          return `<div>• ${materialName}: ${input.rate.toFixed(2)}/min</div>`;
        }).join('');
      }
    }

    // Populate outputs
    const outputsEl = $("#blueprintOutputs");
    if (outputsEl) {
      if (analysis.outputs.length === 0) {
        outputsEl.innerHTML = '<em>No external outputs</em>';
      } else {
        outputsEl.innerHTML = analysis.outputs.map(output => {
          const material = AF.core?.getMaterialById(output.materialId);
          const materialName = material ? material.name : "Unknown";
          return `<div>• ${materialName}: ${output.rate.toFixed(2)}/min</div>`;
        }).join('');
      }
    }

    // Clear form inputs
    const nameInput = $("#blueprintName");
    const descInput = $("#blueprintDescription");
    if (nameInput) nameInput.value = "";
    if (descInput) descInput.value = "";

    dialog.classList.remove("hidden");
    if (nameInput) nameInput.focus();

    // Close on overlay click
    const overlay = dialog.querySelector(".dialog__overlay");
    if (overlay) {
      overlay.onclick = closeDialog;
    }
  }

  // ---------- Cost settings ----------

  function openCostSettingsDialog() {
    const dialog = $("#costSettingsDialog");
    if (!dialog) return;

    // Populate blueprint dropdowns
    const fuelBpSelect = /** @type {HTMLSelectElement|null} */ ($("#costFuelBlueprintSelect"));
    const fuelOutSelect = /** @type {HTMLSelectElement|null} */ ($("#costFuelOutputSelect"));
    const fertBpSelect = /** @type {HTMLSelectElement|null} */ ($("#costFertilizerBlueprintSelect"));
    const fertOutSelect = /** @type {HTMLSelectElement|null} */ ($("#costFertilizerOutputSelect"));

    const blueprints = Array.isArray(AF.state.db.blueprints) ? AF.state.db.blueprints : [];
    const settings = AF.state.settings || {};
    const costBlueprints = settings.costBlueprints || {};

    const fuelSel = costBlueprints.fuel || {};
    const fertSel = costBlueprints.fertilizer || {};

    function fillBlueprintOptions(selectEl, filterFn) {
      if (!selectEl) return;
      const current = selectEl.value;
      selectEl.innerHTML = `<option value="">(none)</option>` + blueprints
        .filter(filterFn)
        .map(bp => `<option value="${bp.id}">${escapeHtml(bp.name || "Unnamed Blueprint")}</option>`)
        .join("");
      // Restore selection if possible
      if (current) selectEl.value = current;
    }

    function blueprintOutputsFor(bpId) {
      const bp = blueprints.find(b => b.id === bpId) || null;
      return bp && Array.isArray(bp.outputs) ? bp.outputs : [];
    }

    function fillOutputOptions(selectEl, outputs, type) {
      if (!selectEl) return;
      const opts = outputs
        .map(o => {
          const mat = o && o.materialId ? AF.core.getMaterialById(o.materialId) : null;
          if (!mat) return null;
          if (type === "fuel" && !mat.isFuel) return null;
          if (type === "fertilizer" && !mat.isFertilizer) return null;
          return `<option value="${mat.id}">${escapeHtml(mat.name)}</option>`;
        })
        .filter(Boolean)
        .join("");
      selectEl.innerHTML = `<option value="">(auto)</option>${opts}`;
    }

    // Filter blueprints by having at least one qualifying output
    fillBlueprintOptions(fuelBpSelect, bp => (bp.outputs || []).some(o => {
      const mat = o && o.materialId ? AF.core.getMaterialById(o.materialId) : null;
      return !!mat && !!mat.isFuel;
    }));
    fillBlueprintOptions(fertBpSelect, bp => (bp.outputs || []).some(o => {
      const mat = o && o.materialId ? AF.core.getMaterialById(o.materialId) : null;
      return !!mat && !!mat.isFertilizer;
    }));

    if (fuelBpSelect) fuelBpSelect.value = fuelSel.blueprintId || "";
    if (fertBpSelect) fertBpSelect.value = fertSel.blueprintId || "";

    // Initial output lists
    fillOutputOptions(fuelOutSelect, blueprintOutputsFor(fuelSel.blueprintId), "fuel");
    fillOutputOptions(fertOutSelect, blueprintOutputsFor(fertSel.blueprintId), "fertilizer");

    if (fuelOutSelect) fuelOutSelect.value = fuelSel.outputMaterialId || "";
    if (fertOutSelect) fertOutSelect.value = fertSel.outputMaterialId || "";

    // Change handlers to update output lists when blueprint changes
    if (fuelBpSelect && fuelOutSelect) {
      fuelBpSelect.onchange = () => {
        fillOutputOptions(fuelOutSelect, blueprintOutputsFor(fuelBpSelect.value), "fuel");
      };
    }
    if (fertBpSelect && fertOutSelect) {
      fertBpSelect.onchange = () => {
        fillOutputOptions(fertOutSelect, blueprintOutputsFor(fertBpSelect.value), "fertilizer");
      };
    }

    dialog.classList.remove("hidden");
    const overlay = dialog.querySelector(".dialog__overlay");
    if (overlay) overlay.onclick = closeDialog;
  }

  function saveCostSettingsFromDialog() {
    const fuelBpSelect = /** @type {HTMLSelectElement|null} */ ($("#costFuelBlueprintSelect"));
    const fuelOutSelect = /** @type {HTMLSelectElement|null} */ ($("#costFuelOutputSelect"));
    const fertBpSelect = /** @type {HTMLSelectElement|null} */ ($("#costFertilizerBlueprintSelect"));
    const fertOutSelect = /** @type {HTMLSelectElement|null} */ ($("#costFertilizerOutputSelect"));

    if (!AF.state.settings) AF.state.settings = { version: 1, costBlueprints: { fuel: { blueprintId: null, outputMaterialId: null }, fertilizer: { blueprintId: null, outputMaterialId: null } } };
    if (!AF.state.settings.costBlueprints) AF.state.settings.costBlueprints = { fuel: { blueprintId: null, outputMaterialId: null }, fertilizer: { blueprintId: null, outputMaterialId: null } };

    AF.state.settings.costBlueprints.fuel.blueprintId = fuelBpSelect?.value || null;
    AF.state.settings.costBlueprints.fuel.outputMaterialId = fuelOutSelect?.value || null;
    AF.state.settings.costBlueprints.fertilizer.blueprintId = fertBpSelect?.value || null;
    AF.state.settings.costBlueprints.fertilizer.outputMaterialId = fertOutSelect?.value || null;

    AF.core?.saveSettings?.();
    closeDialog();
    setStatus("Saved cost settings.", "success");
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: false });
  }


  function centerAllMachinesAtOrigin() {
    if (AF.state.build.placedMachines.length === 0) {
      setStatus("No machines to center.", "error");
      return;
    }

    // Calculate bounding box of all machines
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    AF.state.build.placedMachines.forEach(pm => {
      const machineEl = document.querySelector(`[data-placed-machine="${pm.id}"]`);
      if (!machineEl) return;

      const width = machineEl.offsetWidth;
      const height = machineEl.offsetHeight;

      minX = Math.min(minX, pm.x);
      minY = Math.min(minY, pm.y);
      maxX = Math.max(maxX, pm.x + width);
      maxY = Math.max(maxY, pm.y + height);
    });

    // Calculate center of bounding box
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Calculate offset to move center to origin
    const offsetX = -centerX;
    const offsetY = -centerY;

    // Apply offset to all machines
    AF.state.build.placedMachines.forEach(pm => {
      pm.x += offsetX;
      pm.y += offsetY;
    });

    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: true });
    setStatus("All machines centered at origin.");
  }

  function addMachineToCanvas(machineId) {
    const machine = AF.core.getMachineById(machineId);
    if (!machine) return;

    const id = makeId("pm");

    // Place new machines at camera position with a stagger offset
    const offset = AF.state.build.placedMachines.length * 50;
    const placedMachine = {
      id,
      type: "machine",
      machineId,
      recipeId: null,
      count: 1,
      x: AF.state.build.camera.x + offset,
      y: AF.state.build.camera.y + offset,
    };

    // Initialize storage-specific fields
    if (machine.kind === "storage") {
      placedMachine.storageSlots = machine.storageSlots;
      placedMachine.inventories = [];
      placedMachine.manualInventories = [];
    }

    // Initialize heating device-specific fields
    if (machine.kind === "heating_device") {
      placedMachine.toppers = []; // Array of { machineId, recipeId, count }
      placedMachine.previewFuelId = null; // For showing fuel requirements when not connected
    }

    AF.state.build.placedMachines.push(placedMachine);
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: false });
    setStatus(`Added ${machine.name} to canvas.`);
  }

  function addBlankMachineToCanvas(x, y) {
    const id = makeId("pm");
    const placedMachine = {
      id,
      type: "machine",
      machineId: null, // No machine selected yet
      recipeId: null,
      count: 1,
      x: x !== undefined ? x : AF.state.build.camera.x,
      y: y !== undefined ? y : AF.state.build.camera.y,
    };

    AF.state.build.placedMachines.push(placedMachine);
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: false });
    setStatus("Machine card added. Select a machine type.");
  }

  function addStorageToCanvas(x, y, machineId) {
    const machine = AF.core.getMachineById(machineId);
    if (!machine || machine.kind !== "storage") {
      setStatus("Invalid storage machine.", "error");
      return;
    }

    const id = makeId("pm");
    const placedMachine = {
      id,
      type: "machine",
      machineId: machineId,
      recipeId: null,
      count: 1,
      storageSlots: machine.storageSlots,
      inventories: [],
      manualInventories: [],
      x: x || 100,
      y: y || 100,
    };

    AF.state.build.placedMachines.push(placedMachine);
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: true });
    setStatus(`${machine.name} added to canvas.`);
  }

  function addPurchasingPortalToCanvas(x, y) {
    const id = makeId("pm");
    const placedMachine = {
      id,
      type: "purchasing_portal",
      machineId: null,
      recipeId: null,
      count: 1,
      materialId: null, // Material to purchase
      x: x !== undefined ? x : AF.state.build.camera.x,
      y: y !== undefined ? y : AF.state.build.camera.y,
    };

    AF.state.build.placedMachines.push(placedMachine);
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: true });
    setStatus("Purchasing Portal added to canvas.");
  }

  function addExportNodeToCanvas(x, y) {
    const id = makeId("pm");
    const placedMachine = {
      id,
      type: "export",
      machineId: null,
      recipeId: null,
      count: 1,
      x: x !== undefined ? x : AF.state.build.camera.x,
      y: y !== undefined ? y : AF.state.build.camera.y,
    };

    AF.state.build.placedMachines.push(placedMachine);
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true });
    setStatus("Export node added to canvas.");
  }

  function addNurseryToCanvas(x, y) {
    const id = makeId("pm");
    const placedMachine = {
      id,
      type: "nursery",
      machineId: null,
      recipeId: null,
      count: 1,
      plantId: null, // Plant material
      fertilizerId: null, // Fertilizer material (for preview when not connected)
      x: x !== undefined ? x : AF.state.build.camera.x,
      y: y !== undefined ? y : AF.state.build.camera.y,
    };

    AF.state.build.placedMachines.push(placedMachine);
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: true });
    setStatus("Nursery added to canvas.");
  }

  function updatePlacedMachineType(placedMachineId, machineId) {
    const pm = AF.state.build.placedMachines.find(m => m.id === placedMachineId);
    if (!pm) return;

    const machine = AF.core.getMachineById(machineId);

    // Update machine type
    pm.machineId = machineId;
    pm.recipeId = null; // Reset recipe when changing machine type

    // Initialize kind-specific fields
    if (machine && machine.kind === "storage") {
      pm.storageSlots = machine.storageSlots;
      pm.inventories = [];
      pm.manualInventories = [];
      delete pm.toppers;
      delete pm.previewFuelId;
    } else if (machine && machine.kind === "heating_device") {
      pm.toppers = [];
      pm.previewFuelId = null;
      delete pm.storageSlots;
      delete pm.inventories;
      delete pm.manualInventories;
    } else {
      // Clear kind-specific fields for standard machines
      delete pm.storageSlots;
      delete pm.inventories;
      delete pm.manualInventories;
      delete pm.toppers;
      delete pm.previewFuelId;
    }

    // Remove any existing connections
    AF.state.build.connections = AF.state.build.connections.filter(
      conn => conn.fromMachineId !== placedMachineId && conn.toMachineId !== placedMachineId
    );

    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreation since machine content changed

    if (machine) {
      setStatus(`Machine type changed to ${machine.name}.`);
    }
  }

  function selectConnection(connectionId) {
    AF.state.build.selectedConnection = connectionId;
    AF.state.build.selectedMachines = []; // Deselect any selected machines
    updateSelectionClasses();
    // Selection highlight only - no need to recalculate production
    AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true });
  }

  function clonePlacedMachine(machineId) {
    const original = AF.state.build.placedMachines.find(pm => pm.id === machineId);
    if (!original) return;

    // Create a new ID
    const newId = makeId("pm");

    // Deep clone the machine (excluding connections)
    const clone = {
      ...original,
      id: newId,
      x: original.x + 50, // Offset position
      y: original.y + 50,
    };

    // Deep clone toppers for heating devices
    if (clone.toppers && Array.isArray(clone.toppers)) {
      clone.toppers = clone.toppers.map(topper => ({
        ...topper,
        machineId: topper.machineId,
        recipeId: topper.recipeId,
        count: topper.count
      }));
    }

    // Deep clone manual inventories for storage
    if (clone.manualInventories && Array.isArray(clone.manualInventories)) {
      clone.manualInventories = clone.manualInventories.map(inv => ({
        ...inv,
        materialId: inv.materialId,
        slotsAllocated: inv.slotsAllocated,
        currentAmount: inv.currentAmount
      }));
    }

    // Clear calculated inventories (will be recalculated)
    if (clone.inventories) {
      delete clone.inventories;
    }

    AF.state.build.placedMachines.push(clone);
    AF.core?.saveBuild?.();
    // Topology changed (new machine), must recalc flows + summary
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true });
    setStatus(`Machine cloned successfully.`);
  }


  async function deleteSelectedMachines() {
    if (AF.state.build.selectedMachines.length === 0) return;

    const count = AF.state.build.selectedMachines.length;
    const confirmMsg = count === 1
      ? "Remove this machine and all its connections from the canvas?"
      : `Remove ${count} machines and all their connections from the canvas?`;

    const ok = await AF.ui.dialog.confirm(confirmMsg, { title: "Remove machines", danger: true });
    if (!ok) return;

    // Remove all selected machines
    AF.state.build.placedMachines = AF.state.build.placedMachines.filter(
      pm => !AF.state.build.selectedMachines.includes(pm.id)
    );

    // Remove all connections to/from selected machines
    AF.state.build.connections = AF.state.build.connections.filter(conn =>
      !AF.state.build.selectedMachines.includes(conn.fromMachineId) &&
      !AF.state.build.selectedMachines.includes(conn.toMachineId)
    );

    AF.state.build.selectedMachines = [];
    AF.core?.saveBuild?.();
    // Topology changed (machines removed), must recalc flows + summary
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true });
    setStatus(`${count} machine${count > 1 ? 's' : ''} removed from canvas.`);
  }

  function deletePlacedMachine(machineId) {
    // No confirmation needed - already handled by UI confirm button
    AF.state.build.placedMachines = AF.state.build.placedMachines.filter(pm => pm.id !== machineId);
    AF.state.build.connections = AF.state.build.connections.filter(
      conn => conn.fromMachineId !== machineId && conn.toMachineId !== machineId
    );

    // Remove from selection if selected
    AF.state.build.selectedMachines = AF.state.build.selectedMachines.filter(id => id !== machineId);

    AF.core?.saveBuild?.();
    // Topology changed (machine removed), must recalc flows + summary
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true });
    setStatus("Machine removed from canvas.");
  }

  async function deleteConnection(connectionId) {
    const conn = AF.state.build.connections.find(c => c.id === connectionId);
    if (!conn) return;

    const ok = await AF.ui.dialog.confirm("Remove this connection?", { title: "Remove connection", danger: true });
    if (!ok) return;

    AF.state.build.connections = AF.state.build.connections.filter(c => c.id !== connectionId);

    if (AF.state.build.selectedConnection === connectionId) {
      AF.state.build.selectedConnection = null;
    }

    AF.core?.saveBuild?.();
    // Topology changed (connection removed), must recalc flows + summary
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true });
    setStatus("Connection removed.");
  }

  function updatePlacedMachineRecipe(machineId, recipeId) {
    const pm = AF.state.build.placedMachines.find(m => m.id === machineId);
    if (!pm) return;

    pm.recipeId = recipeId || null;

    // Remove connections that are no longer valid (only for numeric port indices)
    const recipe = recipeId ? AF.core?.getRecipeById(recipeId) : null;
    if (recipe) {
      AF.state.build.connections = AF.state.build.connections.filter(conn => {
        // Only validate numeric port indices (standard machines)
        const fromPortIsNumeric = typeof conn.fromPortIdx === 'number' || !isNaN(Number(conn.fromPortIdx));
        const toPortIsNumeric = typeof conn.toPortIdx === 'number' || !isNaN(Number(conn.toPortIdx));

        if (conn.fromMachineId === machineId && fromPortIsNumeric && Number(conn.fromPortIdx) >= recipe.outputs.length) return false;
        if (conn.toMachineId === machineId && toPortIsNumeric && Number(conn.toPortIdx) >= recipe.inputs.length) return false;
        return true;
      });
    }

    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: true }); // Force recreation since recipe changed
  }


  function wireImportInput() {
    const input = $("#importFileInput");
    if (!input) return;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await importDbFromFile(file);
      } catch (err) {
        console.error(err);
        setStatus("Failed to import JSON (invalid file).", "error");
      }
    });
  }

  function updatePlacedMachineCount(machineId, count) {
    const pm = AF.state.build.placedMachines.find(m => m.id === machineId);
    if (!pm) return;

    pm.count = count;
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreate - count display changed
  }

  function updatePurchasingPortalMaterial(machineId, materialId) {
    const pm = AF.state.build.placedMachines.find(m => m.id === machineId);
    if (!pm || pm.type !== "purchasing_portal") return;

    pm.materialId = materialId || null;
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreate - material selection changed
  }

  function updateNurseryPlant(machineId, plantId) {
    const pm = AF.state.build.placedMachines.find(m => m.id === machineId);
    if (!pm || pm.type !== "nursery") return;

    pm.plantId = plantId || null;
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreate - plant selection changed
  }

  function updateNurseryFertilizer(machineId, fertilizerId) {
    const pm = AF.state.build.placedMachines.find(m => m.id === machineId);
    if (!pm || pm.type !== "nursery") return;

    pm.fertilizerId = fertilizerId || null;
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreate - fertilizer selection changed
  }

  function updateHeatingDevicePreviewFuel(machineId, fuelId) {
    const pm = AF.state.build.placedMachines.find(m => m.id === machineId);
    if (!pm) return;

    const machine = AF.core.getMachineById(pm.machineId);
    if (!machine || machine.kind !== "heating_device") return;

    pm.previewFuelId = fuelId || null;
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreate - fuel selection changed
  }

  function updateStorageSlots(machineId, slots) {
    const pm = AF.state.build.placedMachines.find(m => m.id === machineId);
    if (!pm) return;

    const machine = AF.core.getMachineById(pm.machineId);
    if (!machine || machine.kind !== "storage") return;

    // Enforce max from definition
    pm.storageSlots = Math.min(slots, machine.storageSlots);
    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreate - storage slots changed
  }

  async function importDbFromFile(file) {
    // Use the new importFullState which handles both formats
    await AF.core?.importFullState?.(file);
  }

  async function importBuildFromFile(file) {
    await AF.core?.importBuildState?.(file);
  }



  function addRecipeForMaterial() {
    const materialId = AF.state.ui.selected.materials;
    if (!materialId) return;

    const material = AF.core.getMaterialById(materialId);
    if (!material) return;

    const id = AF.core.makeId("rec");
    AF.state.db.recipes.push({
      id,
      name: `New ${material.name} Recipe`,
      machineId: "",
      processingTimeSec: 1,
      inputs: [{ materialId: "", items: 0 }],
      outputs: [{ materialId: material.id, items: 1 }], // Auto-set this material as output
      heatConsumptionP: null,
    });

    AF.core?.saveDb?.();
    renderMaterials(); // Re-render to show the new recipe
    setStatus("Recipe added.");

    // Expand the newly created recipe card
    setTimeout(() => {
      const card = $(`.recipeCard[data-recipe-id="${id}"]`);
      if (card) {
        card.classList.add("is-open");
        card.querySelector(".recipeCard__body")?.classList.remove("hidden");
      }
    }, 50);
  }

  async function deleteRecipe(recipeId) {
    if (!recipeId) return;
    const ok = await AF.ui.dialog.confirm("Delete this recipe?", { title: "Delete recipe", danger: true });
    if (!ok) return;

    AF.state.db.recipes = AF.state.db.recipes.filter((r) => r.id !== recipeId);
    AF.core?.saveDb?.();
    renderMaterials(); // Re-render to update the recipe list
    setStatus("Recipe deleted.");
  }

  async function deleteSelected(kind) {
    const id = AF.state.ui.selected[kind];
    if (!id) return;
    const ok = await AF.ui.dialog.confirm("Delete this item?", { title: "Delete item", danger: true });
    if (!ok) return;

    if (kind === "materials") {
      // Also remove material references from recipes
      AF.state.db.recipes = AF.state.db.recipes.map((r) => ({
        ...r,
        inputs: r.inputs.filter((io) => io.materialId !== id),
        outputs: r.outputs.filter((io) => io.materialId !== id),
      }));
      AF.state.db.materials = AF.state.db.materials.filter((m) => m.id !== id);
      AF.state.ui.selected.materials = null;
      AF.core?.saveDb?.();
      renderAllUIElements();
      setStatus("Material deleted.");
      return;
    }
    if (kind === "machines") {
      AF.state.db.machines = AF.state.db.machines.filter((m) => m.id !== id);
      // Unset machine references in recipes
      AF.state.db.recipes = AF.state.db.recipes.map((r) => (r.machineId === id ? { ...r, machineId: "" } : r));
      AF.state.ui.selected.machines = null;
      AF.core?.saveDb?.();
      renderAllUIElements();
      setStatus("Machine deleted.");
      return;
    }
  }

  function onSaveMaterial(form, id) {
    const m = AF.core.getMaterialById(id);
    if (!m) return;

    const fd = new FormData(form);
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return setStatus("Material name is required.", "error");

    const buyPrice = toNumberOrNull(fd.get("buyPrice"));
    const salePrice = toNumberOrNull(fd.get("salePrice"));
    const isFuel = fd.get("isFuel") === "on";
    const fuelValue = toNumberOrNull(fd.get("fuelValue"));
    const stackSize = toNumberOrNull(fd.get("stackSize"));
    const isFertilizer = fd.get("isFertilizer") === "on";
    const fertilizerNutrientValue = toNumberOrNull(fd.get("fertilizerNutrientValue"));
    const fertilizerMaxFertility = toNumberOrNull(fd.get("fertilizerMaxFertility"));
    const isPlant = fd.get("isPlant") === "on";
    const plantRequiredNutrient = toNumberOrNull(fd.get("plantRequiredNutrient"));

    // Ensure flags are mutually exclusive
    const selectedFlags = [isFuel, isFertilizer, isPlant].filter(Boolean);
    if (selectedFlags.length > 1) {
      return setStatus("Material can only be one type: Fuel, Fertilizer, or Plant.", "error");
    }

    m.name = name;
    m.buyPrice = buyPrice;
    m.salePrice = salePrice;
    m.isFuel = isFuel;
    m.fuelValue = isFuel ? fuelValue : null;
    m.isFertilizer = isFertilizer;
    m.fertilizerNutrientValue = isFertilizer ? fertilizerNutrientValue : null;
    m.fertilizerMaxFertility = isFertilizer ? fertilizerMaxFertility : null;
    m.isPlant = isPlant;
    m.plantRequiredNutrient = isPlant ? plantRequiredNutrient : null;
    m.stackSize = stackSize && stackSize > 0 ? Math.trunc(stackSize) : 1;

    AF.core?.saveDb?.();
    renderMaterials();
    setStatus("Material saved.", "ok");
  }

  function onSaveMachine(form, id) {
    const m = AF.core.getMachineById(id);
    if (!m) return;

    const fd = new FormData(form);
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return setStatus("Machine name is required.", "error");

    const inputs = toIntOrNull(fd.get("inputs")) ?? 0;
    const outputs = toIntOrNull(fd.get("outputs")) ?? 0;
    const kindValue = fd.get("kind");
    let kind = "standard";
    if (kindValue === "heating_device") kind = "heating_device";
    else if (kindValue === "storage") kind = "storage";

    m.name = name;
    m.inputs = Math.max(0, inputs);
    m.outputs = Math.max(0, outputs);
    m.kind = kind;

    if (kind === "heating_device") {
      m.requiresFurnace = false;
      m.heatConsumptionP = null;
      m.storageSlots = null;
      m.footprintWidth = null;
      m.footprintLength = null;
      const base = toNumberOrNull(fd.get("baseHeatConsumptionP"));
      m.baseHeatConsumptionP = base == null ? 1 : Math.max(0, base);
      m.heatingAreaWidth = toIntOrNull(fd.get("heatingAreaWidth")) || 1;
      m.heatingAreaLength = toIntOrNull(fd.get("heatingAreaLength")) || 1;
    } else if (kind === "storage") {
      m.requiresFurnace = false;
      m.heatConsumptionP = null;
      m.baseHeatConsumptionP = 1;
      m.heatingAreaWidth = null;
      m.heatingAreaLength = null;
      m.footprintWidth = null;
      m.footprintLength = null;
      const slots = toIntOrNull(fd.get("storageSlots"));
      m.storageSlots = slots && slots > 0 ? slots : null;
      if (!m.storageSlots) return setStatus("Storage slots must be greater than 0.", "error");
    } else {
      // Standard
      m.baseHeatConsumptionP = 1;
      m.storageSlots = null;
      m.heatingAreaWidth = null;
      m.heatingAreaLength = null;
      m.requiresFurnace = fd.get("requiresFurnace") === "on";
      m.heatConsumptionP = m.requiresFurnace ? toNumberOrNull(fd.get("heatConsumptionP")) : null;
      m.footprintWidth = m.requiresFurnace ? (toIntOrNull(fd.get("footprintWidth")) || 1) : null;
      m.footprintLength = m.requiresFurnace ? (toIntOrNull(fd.get("footprintLength")) || 1) : null;
    }

    AF.core?.saveDb?.();
    renderMachines();
    renderMaterials(); // Update recipe displays in materials
    setStatus("Machine saved.", "ok");
  }

  function onSaveRecipe(form, id) {
    const r = AF.core.getRecipeById(id);
    if (!r) return;

    const fd = new FormData(form);
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return setStatus("Recipe name is required.", "error");

    const machineId = String(fd.get("machineId") ?? "");
    if (!machineId) return setStatus("Recipe machine is required.", "error");
    if (!AF.core.getMachineById(machineId)) return setStatus("Selected machine does not exist.", "error");

    const processingTimeSec = parseTimeString(fd.get("processingTimeSec"));
    if (processingTimeSec == null || processingTimeSec <= 0) return setStatus("Processing time must be > 0. Use format like '2m30s' or plain seconds.", "error");

    const inputs = readIoFromForm(fd, "inputs");
    const outputs = readIoFromForm(fd, "outputs");
    const heatConsumptionP = toNumberOrNull(fd.get("heatConsumptionP"));

    const machine = AF.core.getMachineById(machineId);
    if (!machine) return setStatus("Selected machine does not exist.", "error");

    // Filter inputs to only those with a material selected
    const usedInputs = inputs.filter(inp => inp.materialId && inp.materialId.trim() !== "");

    // Validation: at least 1 input, up to machine's max inputs
    if (usedInputs.length === 0) return setStatus("Recipe must have at least 1 input with a material selected.", "error");
    if (usedInputs.length > machine.inputs) return setStatus(`Recipe cannot have more than ${machine.inputs} input(s) for this machine.`, "error");

    // Outputs must match exactly
    if (outputs.length !== machine.outputs) return setStatus(`Recipe must have exactly ${machine.outputs} output(s) to match the selected machine.`, "error");
    if (outputs.some((x) => !x.materialId)) return setStatus("All outputs must select a material.", "error");

    r.name = name;
    r.machineId = machineId;
    r.processingTimeSec = processingTimeSec;
    r.inputs = usedInputs; // Only save inputs with materials selected
    r.outputs = outputs;
    r.heatConsumptionP = heatConsumptionP;

    AF.core?.saveDb?.();
    renderMaterials(); // Re-render materials to show updated recipe
    setStatus("Recipe saved.", "ok");
  }

  /**
     * Show validation warning to user
     * @param {Array<ValidationIssue>} issues
     * @param {string} source
     * @returns {void}
     */
  function showValidationWarning(issues, source = 'file') {
    if (issues.length === 0) return;

    const warningDiv = document.createElement('div');
    warningDiv.className = 'validation-warning';
    warningDiv.style.cssText = `
    position: fixed;
    top: 60px;
    right: 20px;
    background: rgba(255, 107, 107, 0.95);
    color: white;
    padding: 16px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    max-width: 400px;
    z-index: 10000;
    font-size: 13px;
    line-height: 1.5;
  `;

    const title = document.createElement('div');
    title.style.cssText = 'font-weight: 700; font-size: 14px; margin-bottom: 8px;';
    title.textContent = `⚠️ Invalid Connections Detected (${issues.length})`;

    const message = document.createElement('div');
    message.style.cssText = 'margin-bottom: 12px;';
    message.textContent = `Your ${source} contains ${issues.length} invalid connection${issues.length > 1 ? 's' : ''} that may cause incorrect calculations.`;

    const detailsBtn = document.createElement('button');
    detailsBtn.textContent = 'Show Details';
    detailsBtn.className = 'btn btn--sm';
    detailsBtn.style.cssText = 'margin-right: 8px;';
    detailsBtn.onclick = async () => {
      console.group('🔍 Build Validation Issues');
      issues.forEach(issue => {
        console.warn(issue.message, issue);
      });
      console.groupEnd();
      await AF.ui.dialog.alert(
        `Validation Issues:\n\n${issues.map(i => `• ${i.message}`).join('\n')}\n\nCheck the console for details.`,
        { title: "Validation issues" }
      );
    };

    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.className = 'btn btn--sm';
    dismissBtn.onclick = () => warningDiv.remove();

    warningDiv.appendChild(title);
    warningDiv.appendChild(message);
    warningDiv.appendChild(detailsBtn);
    warningDiv.appendChild(dismissBtn);
    document.body.appendChild(warningDiv);

    // Auto-dismiss after 15 seconds
    setTimeout(() => {
      if (warningDiv.parentNode) {
        warningDiv.remove();
      }
    }, 15000);
  }


  /**
   * Convert screen coordinates to world coordinates
   * @param {number} screenX - X coordinate in screen space (relative to canvas)
   * @param {number} screenY - Y coordinate in screen space (relative to canvas)
   * @returns {{ x: number, y: number }} World coordinates
   */
  function screenToWorld(screenX, screenY) {
    const canvas = $("#designCanvas");
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const { x: camX, y: camY, zoom } = AF.state.build.camera;

    // Calculate offset from viewport center
    const offsetX = screenX - centerX;
    const offsetY = screenY - centerY;

    // Remove zoom and add camera position
    const worldX = camX + (offsetX / zoom);
    const worldY = camY + (offsetY / zoom);

    return { x: worldX, y: worldY };
  }


  function openJumpToCoordinatesDialog() {
    const dialog = $("#jumpToCoordinatesDialog");
    if (!dialog) return;

    // Pre-fill with current camera position
    const xInput = $("#jumpToX");
    const yInput = $("#jumpToY");
    if (xInput) xInput.value = Math.round(AF.state.build.camera.x);
    if (yInput) yInput.value = Math.round(AF.state.build.camera.y);

    dialog.classList.remove("hidden");

    // Focus on X input
    setTimeout(() => xInput?.select(), 100);

    // Handle Enter key to jump
    const handleKeyPress = (e) => {
      if (e.key === "Enter") {
        jumpToCoordinates();
        dialog.removeEventListener("keypress", handleKeyPress);
      } else if (e.key === "Escape") {
        closeDialog();
        dialog.removeEventListener("keypress", handleKeyPress);
      }
    };
    dialog.addEventListener("keypress", handleKeyPress);

    // Close on overlay click
    const overlay = dialog.querySelector(".dialog__overlay");
    if (overlay) {
      overlay.onclick = closeDialog;
    }
  }

  function jumpToCoordinates() {
    const xInput = $("#jumpToX");
    const yInput = $("#jumpToY");

    if (!xInput || !yInput) return;

    const x = parseFloat(xInput.value) || 0;
    const y = parseFloat(yInput.value) || 0;

    // Move camera to specified coordinates
    AF.state.build.camera.x = x;
    AF.state.build.camera.y = y;

    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: false, needsRender: true, forceRecreate: false });
    closeDialog();
    setStatus(`Jumped to (${Math.round(x)}, ${Math.round(y)})`);
  }

  function updateSelectionClasses() {
    const canvas = $("#designCanvas");
    if (!canvas) return;

    const container = canvas.querySelector("#canvasTransformContainer");
    if (!container) return;

    const selectedSet = new Set(AF.state.build.selectedMachines);
    const selectionCount = AF.state.build.selectedMachines.length;
    const isMultiSelect = selectionCount > 1;

    // Update all machine elements
    AF.state.build.placedMachines.forEach(pm => {
      const el = container.querySelector(`[data-placed-machine="${pm.id}"]`);
      if (!el) return;

      const isSelected = selectedSet.has(pm.id);

      // Update selection class
      if (isSelected) {
        el.classList.add("is-selected");
      } else {
        el.classList.remove("is-selected");
      }

      // Update multi-selection badge
      if (isSelected && isMultiSelect) {
        el.classList.add("is-multi-selected");
        el.style.setProperty('--selection-count', `"${selectionCount}"`);
      } else {
        el.classList.remove("is-multi-selected");
        el.style.removeProperty('--selection-count');
      }
    });

    // Update create blueprint button state
    updateCreateBlueprintButton();
  }

  /**
   * Draw selection box during drag-to-select
   */
  function drawSelectionBox() {
    const canvas = $("#designCanvas");
    if (!canvas || !AF.state.ui.dragState || AF.state.ui.dragState.type !== "select") return;

    // Remove existing selection box
    removeSelectionBox();

    const { startX, startY, currentX, currentY } = AF.state.ui.dragState;
    const canvasRect = canvas.getBoundingClientRect();

    const minX = Math.min(startX, currentX) - canvasRect.left;
    const maxX = Math.max(startX, currentX) - canvasRect.left;
    const minY = Math.min(startY, currentY) - canvasRect.top;
    const maxY = Math.max(startY, currentY) - canvasRect.top;

    const box = document.createElement("div");
    box.id = "selectionBox";
    box.style.position = "absolute";
    box.style.left = `${minX}px`;
    box.style.top = `${minY}px`;
    box.style.width = `${maxX - minX}px`;
    box.style.height = `${maxY - minY}px`;
    box.style.border = "2px dashed var(--primary)";
    box.style.background = "rgba(69, 212, 131, 0.1)";
    box.style.pointerEvents = "none";
    box.style.zIndex = "1000";

    canvas.appendChild(box);
  }

  function removeSelectionBox() {
    const box = $("#selectionBox");
    if (box) box.remove();
  }

  function setStatus(text, kind = "info") {
    const el = $("#statusText");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
    if (AF.state.ui.statusTimer) window.clearTimeout(AF.state.ui.statusTimer);
    AF.state.ui.statusTimer = window.setTimeout(() => {
      el.textContent = "";
    }, 2500);
  }


  function placeBlueprintOnCanvas(blueprintId, x, y) {
    const blueprint = AF.state.db.blueprints.find(bp => bp.id === blueprintId);
    if (!blueprint) return;

    // Create blueprint instance as a container with physical child machines
    const instanceId = makeId("bpi");
    const childIdMap = new Map(); // template ID -> child ID

    // Copy machines as physical children
    const childMachines = blueprint.machines.map(templateMachine => {
      const childId = `${instanceId}__${templateMachine.blueprintMachineId}`;
      childIdMap.set(templateMachine.blueprintMachineId, childId);

      return {
        ...JSON.parse(JSON.stringify(templateMachine)), // Deep copy
        id: childId,
        _parentBlueprintId: instanceId,
        _isChildMachine: true,
        efficiency: 1.0
      };
    });

    // Copy connections with remapped IDs
    const childConnections = (blueprint.connections || []).map(templateConn => {
      return {
        id: `${instanceId}__${makeId("conn")}`,
        fromMachineId: childIdMap.get(templateConn.fromMachineId),
        toMachineId: childIdMap.get(templateConn.toMachineId),
        fromPortIdx: templateConn.fromPortIdx,
        toPortIdx: templateConn.toPortIdx,
        _parentBlueprintId: instanceId
      };
    });

    // Build port mappings (blueprint ports -> internal machines)
    const portMappings = buildBlueprintPortMappings(blueprint, instanceId, childIdMap);

    const blueprintInstance = {
      id: instanceId,
      type: "blueprint_instance",
      blueprintId: blueprint.id,
      detached: false,
      x,
      y,
      count: 1,
      efficiency: 1.0,

      // Physical child machines and connections
      childMachines: childMachines,
      childConnections: childConnections,
      portMappings: portMappings,

      // Keep metadata for display
      name: blueprint.name,
      description: blueprint.description,

      // Keep old blueprintData temporarily for backward compatibility
      blueprintData: {
        name: blueprint.name,
        description: blueprint.description,
        inputs: blueprint.inputs,
        outputs: blueprint.outputs,
        machines: blueprint.machines,
        connections: blueprint.connections,
      }
    };

    AF.state.build.placedMachines.push(blueprintInstance);

    // Select the newly placed blueprint
    AF.state.build.selectedMachines = [blueprintInstance.id];

    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true });
    updateSelectionClasses();

    const displayMachineCount = childMachines.filter(m => m.type !== "export").length;
    setStatus(`Blueprint "${blueprint.name}" placed on canvas (${displayMachineCount} machines inside).`);
  }

  /**
   * Add a blueprint's internal items as normal items on the main canvas.
   * - Does NOT place a blueprint container card.
   * - Expands nested blueprint instances when possible via their stored `portMappings`.
   */
  function addBlueprintItemsToCanvas(blueprintId) {
    if (!blueprintId) return;
    const blueprint = AF.state.db.blueprints.find(bp => bp.id === blueprintId);
    if (!blueprint) return;

    const bbox = measureBlueprintDefinitionBounds(blueprint);
    if (!bbox) {
      setStatus(`Blueprint "${blueprint.name}" has no placeable items.`, "warning");
      return;
    }

    const cam = AF.state.build.camera || { x: 0, y: 0, zoom: 1.0 };
    const contentCenterX = (bbox.minX + bbox.maxX) / 2;
    const contentCenterY = (bbox.minY + bbox.maxY) / 2;
    const offsetX = cam.x - contentCenterX;
    const offsetY = cam.y - contentCenterY;

    // Treat blueprint definition as a graph where node ids are blueprintMachineId
    const graphMachines = (blueprint.machines || []).map(m => {
      const copy = JSON.parse(JSON.stringify(m));
      copy.id = copy.blueprintMachineId;
      return copy;
    });
    const graphConnections = (blueprint.connections || []).map(c => ({
      id: makeId("conn"),
      fromMachineId: c.fromMachineId,
      fromPortIdx: c.fromPortIdx,
      toMachineId: c.toMachineId,
      toPortIdx: c.toPortIdx
    }));

    const flattened = flattenMachineGraphForCanvas(graphMachines, graphConnections, offsetX, offsetY);
    if (!flattened.machines.length) {
      setStatus(`Blueprint "${blueprint.name}" has no placeable items.`, "warning");
      return;
    }

    AF.state.build.placedMachines.push(...flattened.machines);
    AF.state.build.connections.push(...flattened.connections);
    AF.state.build.selectedMachines = flattened.machines.map(m => m.id);

    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true });
    updateSelectionClasses();

    setStatus(`Added "${blueprint.name}" items to canvas (${flattened.machines.length} items).`);
  }

  /**
   * Open a blueprint in edit mode from the sidebar, but force "Save" to create a copy.
   */
  function enterBlueprintEditModeAsCopyFromSidebar(blueprintId) {
    if (!blueprintId) return;
    const blueprint = AF.state.db.blueprints.find(bp => bp.id === blueprintId);
    if (!blueprint) return;

    AF.state.blueprintEditStack.push({
      placedMachines: JSON.parse(JSON.stringify(AF.state.build.placedMachines)),
      connections: JSON.parse(JSON.stringify(AF.state.build.connections)),
      camera: { ...state.build.camera },
      selectedMachines: [...state.build.selectedMachines],
      editContext: AF.state.currentBlueprintEdit ? JSON.parse(JSON.stringify(AF.state.currentBlueprintEdit)) : null,
    });

    // Generate new IDs for editing
    const idMap = new Map();
    const machines = (blueprint.machines || []).map(templateMachine => {
      const newId = makeId("pm");
      idMap.set(templateMachine.blueprintMachineId, newId);
      const machine = JSON.parse(JSON.stringify(templateMachine));
      machine.id = newId;
      return machine;
    });

    const connections = (blueprint.connections || []).map(templateConn => {
      return {
        id: makeId("conn"),
        fromMachineId: idMap.get(templateConn.fromMachineId),
        fromPortIdx: templateConn.fromPortIdx,
        toMachineId: idMap.get(templateConn.toMachineId),
        toPortIdx: templateConn.toPortIdx,
      };
    });

    AF.state.currentBlueprintEdit = {
      instanceId: null,
      blueprintId: blueprint.id,
      detached: false,
      originalBlueprint: JSON.parse(JSON.stringify(blueprint)),
      childIdMap: idMap,
      forceSaveAsNew: true,
      startedFromSidebar: true,
    };

    AF.state.build.placedMachines = machines;
    AF.state.build.connections = connections;
    AF.state.build.selectedMachines = [];
    AF.state.build.camera = { x: 0, y: 0, zoom: 1.0 };

    AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true });
    updateBlueprintEditUI();
    setStatus(`Editing copy of blueprint: ${blueprint.name}`);
  }

  function measureBlueprintDefinitionBounds(blueprint) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;

    function walk(machines, dx, dy) {
      (machines || []).forEach(m => {
        if (!m || m.type === "export") return;

        const x = (Number(m.x) || 0) + dx;
        const y = (Number(m.y) || 0) + dy;

        const hasChildren = Array.isArray(m.childMachines) && m.childMachines.length > 0;
        if ((m.type === "blueprint_instance" || m.type === "blueprint") && hasChildren) {
          walk(m.childMachines, x, y);
          return;
        }

        any = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      });
    }

    walk(blueprint.machines || [], 0, 0);
    if (!any) return null;
    return { minX, minY, maxX, maxY };
  }

  /**
   * Flattens a machine graph onto the canvas by removing blueprint containers and promoting their child machines.
   * @returns {{ machines: Array<any>, connections: Array<any>, oldToNew: Map<string, string> }}
   */
  function flattenMachineGraphForCanvas(machines, connections, offsetX, offsetY) {
    const keptMachines = [];
    const keptConnections = [];

    /** @type {Map<string, string>} */
    const idRemap = new Map(); // old -> new (only for machines kept at this level)

    /** @type {Map<string, { inputs: Map<number, { machineId: string, portIdx: number }>, outputs: Map<number, { machineId: string, portIdx: number }> }>} */
    const containerEndpoints = new Map();

    /** @type {Map<string, string>} */
    const oldToNewAll = new Map(); // includes nested mappings for portMapping resolution

    function isBlueprintContainer(m) {
      return (
        (m.type === "blueprint_instance" || m.type === "blueprint") &&
        Array.isArray(m.childMachines) &&
        Array.isArray(m.childConnections) &&
        m.portMappings &&
        (Array.isArray(m.portMappings.inputs) || Array.isArray(m.portMappings.outputs))
      );
    }

    // 1) Process machines: keep non-container machines, expand containers recursively.
    (machines || []).forEach(m => {
      if (!m || m.type === "export") return;

      const mx = offsetX + (Number(m.x) || 0);
      const my = offsetY + (Number(m.y) || 0);

      if (isBlueprintContainer(m)) {
        const child = flattenMachineGraphForCanvas(m.childMachines, m.childConnections, mx, my);

        keptMachines.push(...child.machines);
        keptConnections.push(...child.connections);

        const endpoints = { inputs: new Map(), outputs: new Map() };

        const inputs = Array.isArray(m.portMappings?.inputs) ? m.portMappings.inputs : [];
        inputs.forEach((mp, idx) => {
          const portIdx = Number(mp?.portIdx ?? idx);
          const internalOldId = mp?.internalMachineId;
          const internalPortIdx = Number(mp?.internalPortIdx ?? 0);
          if (!internalOldId) return;
          const internalNewId = child.oldToNew.get(internalOldId);
          if (!internalNewId) return;
          endpoints.inputs.set(portIdx, { machineId: internalNewId, portIdx: internalPortIdx });
        });

        const outputs = Array.isArray(m.portMappings?.outputs) ? m.portMappings.outputs : [];
        outputs.forEach((mp, idx) => {
          const portIdx = Number(mp?.portIdx ?? idx);
          const internalOldId = mp?.internalMachineId;
          const internalPortIdx = Number(mp?.internalPortIdx ?? 0);
          if (!internalOldId) return;
          const internalNewId = child.oldToNew.get(internalOldId);
          if (!internalNewId) return;
          endpoints.outputs.set(portIdx, { machineId: internalNewId, portIdx: internalPortIdx });
        });

        containerEndpoints.set(m.id, endpoints);

        for (const [k, v] of child.oldToNew.entries()) oldToNewAll.set(k, v);
        return;
      }

      const newId = makeId("pm");
      idRemap.set(m.id, newId);
      oldToNewAll.set(m.id, newId);

      const copy = JSON.parse(JSON.stringify(m));
      copy.id = newId;
      copy.x = mx;
      copy.y = my;
      delete copy._parentBlueprintId;
      delete copy._isChildMachine;
      keptMachines.push(copy);
    });

    function resolveEndpoint(machineId, portIdx, kind) {
      const idx = Number(portIdx);
      if (containerEndpoints.has(machineId)) {
        const ep = kind === "input"
          ? containerEndpoints.get(machineId).inputs.get(idx)
          : containerEndpoints.get(machineId).outputs.get(idx);
        return ep ? { machineId: ep.machineId, portIdx: ep.portIdx } : null;
      }
      const newId = idRemap.get(machineId);
      if (!newId) return null;
      return { machineId: newId, portIdx: idx };
    }

    // 2) Process connections at this level (child connections were already merged above)
    (connections || []).forEach(conn => {
      if (!conn) return;
      const from = resolveEndpoint(conn.fromMachineId, conn.fromPortIdx, "output");
      const to = resolveEndpoint(conn.toMachineId, conn.toPortIdx, "input");
      if (!from || !to) return;
      keptConnections.push({
        id: makeId("conn"),
        fromMachineId: from.machineId,
        fromPortIdx: from.portIdx,
        toMachineId: to.machineId,
        toPortIdx: to.portIdx,
      });
    });

    return { machines: keptMachines, connections: keptConnections, oldToNew: oldToNewAll };
  }


  /**
   * Helper: Build port mappings for a blueprint instance
   * Maps blueprint external ports to internal child machine IDs
   */
  function buildBlueprintPortMappings(blueprint, instanceId, childIdMap) {
    const mappings = { inputs: [], outputs: [] };
    const exportTemplateIds = new Set(
      (blueprint.machines || [])
        .filter(m => m.type === "export")
        .map(m => m.blueprintMachineId)
        .filter(Boolean)
    );

    function getOutputPortIdxForMaterial(machine, materialId) {
      if (!machine) return 0;
      if (machine.type === "purchasing_portal") return 0;
      if (machine.type === "nursery") return 0;
      if (machine.type === "machine" && machine.machineId) {
        const def = AF.core.getMachineById(machine.machineId);
        if (def && def.kind === "heating_device") {
          return `grouped-output-${materialId}`;
        }
      }
      if (machine.type === "machine" && machine.recipeId) {
        const recipe = AF.core.getRecipeById(machine.recipeId);
        if (!recipe || !Array.isArray(recipe.outputs)) return 0;
        const idx = recipe.outputs.findIndex(out => out.materialId === materialId);
        return idx >= 0 ? idx : 0;
      }
      return 0;
    }

    function getInputPortIdxForMaterial(machine, materialId) {
      if (!machine) return 0;
      if (machine.type === "nursery") return 0;
      if (machine.type === "machine" && machine.machineId) {
        const def = AF.core.getMachineById(machine.machineId);
        if (def && def.kind === "heating_device") {
          return `grouped-input-${materialId}`;
        }
      }
      if (machine.type === "machine" && machine.recipeId) {
        const recipe = AF.core.getRecipeById(machine.recipeId);
        if (!recipe || !Array.isArray(recipe.inputs)) return 0;
        const idx = recipe.inputs.findIndex(inp => inp.materialId === materialId);
        return idx >= 0 ? idx : 0;
      }
      return 0;
    }

    // Map inputs - find which internal machine receives from external input
    blueprint.inputs.forEach((input, idx) => {
      // Direct mapping hint (used for special ports like heating device fuel)
      if ((input.kind === "fuel" || (input.materialId == null && input.internalPortIdx === "fuel")) && input.internalBlueprintMachineId) {
        const childId = childIdMap.get(input.internalBlueprintMachineId);
        if (childId) {
          mappings.inputs.push({
            portIdx: idx,
            materialId: null,
            kind: "fuel",
            internalMachineId: childId,
            internalPortIdx: "fuel",
          });
        }
        return;
      }

      // Find internal connections that have no external source
      // These are the machines that need external input
      const externalInputMachines = new Set();

      blueprint.machines.forEach(machine => {
        // Check if this machine needs this material as input
        const needsMaterial = machineNeedsMaterialAsInput(machine, input.materialId);
        if (!needsMaterial) return;

        // Check if this machine gets the material internally
        const hasInternalSource = blueprint.connections.some(conn =>
          conn.toMachineId === machine.blueprintMachineId &&
          getMaterialIdForBlueprintConnection(blueprint, conn, 'output') === input.materialId
        );

        if (!hasInternalSource) {
          externalInputMachines.add(machine.blueprintMachineId);
        }
      });

      // Use the first machine that needs external input (could be multiple)
      if (externalInputMachines.size > 0) {
        const templateId = Array.from(externalInputMachines)[0];
        const childId = childIdMap.get(templateId);
        const templateMachine = blueprint.machines.find(m => m.blueprintMachineId === templateId);
        mappings.inputs.push({
          portIdx: idx,
          materialId: input.materialId,
          internalMachineId: childId,
          internalPortIdx: getInputPortIdxForMaterial(templateMachine, input.materialId)
        });
      }
    });

    // Map outputs - find which internal machine produces external output
    blueprint.outputs.forEach((output, idx) => {
      // Find internal machines that produce this material and either:
      // - have no internal consumer for it, OR
      // - feed an Export node (export is treated as external demand for blueprint IO)
      const exportingMachines = [];
      const noConsumerMachines = [];

      blueprint.machines.forEach(machine => {
        // Check if this machine produces this material
        const producesMaterial = machineProducesMaterial(machine, output.materialId);
        if (!producesMaterial) return;

        const outgoingForMaterial = (blueprint.connections || []).filter(conn =>
          conn.fromMachineId === machine.blueprintMachineId &&
          getMaterialIdForBlueprintConnection(blueprint, conn, "output") === output.materialId
        );

        const feedsExport = outgoingForMaterial.some(conn => exportTemplateIds.has(conn.toMachineId));
        const feedsNonExport = outgoingForMaterial.some(conn => !exportTemplateIds.has(conn.toMachineId));

        if (feedsExport) exportingMachines.push(machine.blueprintMachineId);
        if (!feedsNonExport) noConsumerMachines.push(machine.blueprintMachineId);
      });

      // Prefer mapping outputs to a machine that feeds an Export node (this is the "exported" flow).
      // Fall back to a machine that has no internal consumer (classic external output).
      const templateId = exportingMachines[0] || noConsumerMachines[0] || null;
      if (templateId) {
        const childId = childIdMap.get(templateId);
        const templateMachine = blueprint.machines.find(m => m.blueprintMachineId === templateId);
        mappings.outputs.push({
          portIdx: idx,
          materialId: output.materialId,
          internalMachineId: childId,
          internalPortIdx: getOutputPortIdxForMaterial(templateMachine, output.materialId)
        });
      }
    });

    return mappings;
  }


  async function deleteBlueprint(blueprintId) {
    if (!blueprintId) return;

    const blueprint = AF.state.db.blueprints.find(bp => bp.id === blueprintId);
    if (!blueprint) return;

    // Check if blueprint is used in other blueprints (nested)
    const usedInBlueprints = AF.state.db.blueprints.filter(bp => {
      if (bp.id === blueprintId) return false; // Don't check self
      return bp.machines.some(m => m.type === "blueprint" && m.blueprintId === blueprintId);
    });

    // Check if blueprint is placed on the canvas
    const placedInstances = AF.state.build.placedMachines.filter(
      pm => (pm.type === "blueprint" || pm.type === "blueprint_instance") && pm.blueprintId === blueprintId
    );

    // Check if blueprint is in the edit stack (currently being edited)
    const isBeingEdited = AF.state.blueprintEditStack.some(frame => {
      return frame.placedMachines.some(pm => (pm.type === "blueprint" || pm.type === "blueprint_instance") && pm.blueprintId === blueprintId);
    });

    // Build error message if in use
    const errors = [];
    if (usedInBlueprints.length > 0) {
      const blueprintNames = usedInBlueprints.map(bp => `"${bp.name}"`).join(", ");
      errors.push(`Used in ${usedInBlueprints.length} other blueprint${usedInBlueprints.length > 1 ? 's' : ''}: ${blueprintNames}`);
    }
    if (placedInstances.length > 0) {
      errors.push(`${placedInstances.length} instance${placedInstances.length > 1 ? 's' : ''} placed on the canvas`);
    }
    if (isBeingEdited) {
      errors.push(`Currently being edited in a nested blueprint`);
    }

    if (errors.length > 0) {
      await AF.ui.dialog.alert(
        `Cannot delete blueprint "${blueprint.name}":\n\n• ${errors.join("\n• ")}\n\nRemove all usages first.`,
        { title: "Cannot delete blueprint" }
      );
      return;
    }

    // Safe to delete
    const ok = await AF.ui.dialog.confirm(
      `Delete blueprint "${blueprint.name}"? This action cannot be undone.`,
      { title: "Delete blueprint", danger: true, okText: "Delete" }
    );
    if (!ok) return;

    AF.state.db.blueprints = AF.state.db.blueprints.filter(bp => bp.id !== blueprintId);

    // Invalidate cache
    AF.calculator?.invalidateBlueprintCountCache?.(blueprintId);

    AF.core?.saveDb?.();
    renderBlueprintsList();
    setStatus(`Blueprint "${blueprint.name}" deleted.`);
  }

  function machineNeedsMaterialAsInput(machine, materialId) {
    if (machine.type === "machine" && machine.recipeId) {
      const recipe = AF.core.getRecipeById(machine.recipeId);
      return recipe && recipe.inputs.some(inp => inp.materialId === materialId);
    }
    // Heating device grouped inputs (toppers)
    if (machine.type === "machine" && machine.machineId) {
      const def = AF.core.getMachineById(machine.machineId);
      if (def && def.kind === "heating_device") {
        return (machine.toppers || []).some(t => {
          if (!t.recipeId) return false;
          const r = AF.core.getRecipeById(t.recipeId);
          return !!r && (r.inputs || []).some(inp => inp.materialId === materialId);
        });
      }
    }
    return false;
  }

  function machineProducesMaterial(machine, materialId) {
    if (machine.type === "purchasing_portal") {
      return machine.materialId === materialId;
    }
    if (machine.type === "machine" && machine.recipeId) {
      const recipe = AF.core.getRecipeById(machine.recipeId);
      return recipe && recipe.outputs.some(out => out.materialId === materialId);
    }
    // Heating device grouped outputs (toppers)
    if (machine.type === "machine" && machine.machineId) {
      const def = AF.core.getMachineById(machine.machineId);
      if (def && def.kind === "heating_device") {
        return (machine.toppers || []).some(t => {
          if (!t.recipeId) return false;
          const r = AF.core.getRecipeById(t.recipeId);
          return !!r && (r.outputs || []).some(out => out.materialId === materialId);
        });
      }
    }
    return false;
  }

  function getMaterialIdForBlueprintConnection(blueprint, conn, portType) {
    const machine = blueprint.machines.find(m =>
      m.blueprintMachineId === (portType === 'output' ? conn.fromMachineId : conn.toMachineId)
    );
    if (!machine) return null;

    if (machine.type === "purchasing_portal") {
      return machine.materialId;
    }
    if (machine.type === "machine" && machine.machineId) {
      const def = AF.core.getMachineById(machine.machineId);
      if (def && def.kind === "heating_device") {
        // Grouped ports carry materialId encoded in the port string.
        if (portType === "output" && typeof conn.fromPortIdx === "string" && conn.fromPortIdx.startsWith("grouped-output-")) {
          return conn.fromPortIdx.replace(/^grouped-output-/, "") || null;
        }
        if (portType === "input" && typeof conn.toPortIdx === "string" && conn.toPortIdx.startsWith("grouped-input-")) {
          return conn.toPortIdx.replace(/^grouped-input-/, "") || null;
        }
        return null;
      }
    }
    if (machine.type === "machine" && machine.recipeId) {
      const recipe = AF.core.getRecipeById(machine.recipeId);
      if (!recipe) return null;

      if (portType === 'output') {
        const output = recipe.outputs[conn.fromPortIdx];
        return output?.materialId;
      } else {
        const input = recipe.inputs[conn.toPortIdx];
        return input?.materialId;
      }
    }
    return null;
  }

  // NOTE: The bulk render functions (renderAll/materials/machines/etc.) are defined
  // later in this file (legacy split). Export them at the end too.

  // ---------- Rendering ----------

  function renderAllUIElements() {
    renderWorkspaceTabsUI();
    renderTabs();
    renderMaterials();
    renderMachines();
    renderSkillsBar();
    renderBlueprintsList();
    updateCreateBlueprintButton();
    updateLayoutGridColumns();
  }

  function renderWorkspaceTabsUI() {
    const list = $("#workspaceTabsList");
    const nameEl = $("#activeWorkspaceName");
    if (!list || !nameEl) return;

    const tabs = Array.isArray(AF.state.workspaces?.tabs) ? AF.state.workspaces.tabs : [];
    const activeId = AF.state.workspaces?.activeId ?? null;

    list.innerHTML = tabs
      .map(t => {
        const isActive = t.id === activeId;
        return `
          <button
            type="button"
            class="workspaceTab${isActive ? " is-active" : ""}"
            role="tab"
            aria-selected="${isActive ? "true" : "false"}"
            data-action="workspace:switch"
            data-workspace-id="${escapeHtml(t.id)}"
            title="${escapeHtml(t.name || "New Production")}"
          >
            <span class="workspaceTab__name">${escapeHtml(t.name || "New Production")}</span>
            <span
              class="workspaceTab__close"
              role="button"
              aria-label="Close tab"
              data-action="workspace:close"
              data-workspace-id="${escapeHtml(t.id)}"
              title="Close"
            >✕</span>
          </button>
        `;
      })
      .join("");

    const active = AF.core?.getActiveWorkspaceTab?.() || null;
    nameEl.textContent = active?.name || (tabs[0]?.name ?? "New Production 1");
  }

  function renderTabs() {
    $$(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === AF.state.ui.activeTab));
    $$("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== AF.state.ui.activeTab));
  }

  function renderMaterials() {
    const listEl = $("#materialsList");
    const editorEl = $("#materialEditor");
    const currentEl = $('[data-dropdown-toggle="materials"]');
    if (!listEl || !editorEl || !currentEl) return;

    const q = AF.state.ui.filters.materials;
    const items = filterByName([...AF.state.db.materials].sort(AF.core.compareByName), q);
    listEl.innerHTML = items
      .map((m) => {
        const selected = AF.state.ui.selected.materials === m.id ? " is-selected" : "";
        const metaParts = [];

        // Calculate realized cost
        const realizedCost = AF.calculator.calculateRealizedCost(m.id);
        if (Number.isFinite(realizedCost)) {
          metaParts.push(`Cost: ${realizedCost.toFixed(2)}`);
        } else {
          metaParts.push(`Cost: —`);
        }

        if (m.buyPrice != null) metaParts.push(`Buy: ${m.buyPrice}`);
        if (m.salePrice != null) metaParts.push(`Sell: ${m.salePrice}`);
        if (m.isFuel) metaParts.push(`Fuel (${m.fuelValue ?? "?"}P)`);
        if (m.isFertilizer) metaParts.push(`Fertilizer (${m.fertilizerNutrientValue ?? "?"}V, ${m.fertilizerMaxFertility ?? "?"}V/s)`);
        if (m.isPlant) metaParts.push(`Plant (${m.plantRequiredNutrient ?? "?"}V)`);
        return `
            <div class="listItem${selected}" data-kind="materials" data-id="${escapeHtml(m.id)}" tabindex="0">
              <div class="listItem__title">${escapeHtml(m.name)}</div>
              <div class="listItem__meta">${escapeHtml(metaParts.join(" • ") || "—")}</div>
            </div>
          `;
      })
      .join("");

    // Update current selection display
    const selectedId = AF.state.ui.selected.materials;
    const selected = selectedId ? AF.core.getMaterialById(selectedId) : null;
    if (selected) {
      const metaParts = [];
      const realizedCost = AF.calculator.calculateRealizedCost(selected.id);
      if (Number.isFinite(realizedCost)) metaParts.push(`Cost: ${realizedCost.toFixed(2)}`);
      else metaParts.push(`Cost: —`);
      if (selected.buyPrice != null) metaParts.push(`Buy: ${selected.buyPrice}`);
      if (selected.salePrice != null) metaParts.push(`Sell: ${selected.salePrice}`);
      if (selected.isFuel) metaParts.push(`Fuel (${selected.fuelValue ?? "?"}P)`);
      if (selected.isFertilizer) metaParts.push(`Fert (${selected.fertilizerNutrientValue ?? "?"}V)`);
      if (selected.isPlant) metaParts.push(`Plant (${selected.plantRequiredNutrient ?? "?"}V)`);

      currentEl.innerHTML = `
          <div class="dropdownSelector__selectedItem">
            <div class="dropdownSelector__selectedTitle">${escapeHtml(selected.name)}</div>
            <div class="dropdownSelector__selectedMeta">${escapeHtml(metaParts.join(" • ") || "—")}</div>
          </div>
          <div class="dropdownSelector__arrow">▼</div>
        `;
    } else {
      currentEl.innerHTML = `
          <div class="dropdownSelector__placeholder">Select a material...</div>
          <div class="dropdownSelector__arrow">▼</div>
        `;
    }

    editorEl.innerHTML = selected ? renderMaterialForm(selected) : `<div class="emptyState">Select a material or click "Add".</div>`;
  }

  function renderMaterialForm(m) {
    const template = $("#materialFormTemplate");
    if (!template) return "";
    // Clone the entire template content (form + recipes section)
    const fragment = template.content.cloneNode(true);
    const form = fragment.querySelector("form");

    form.dataset.id = m.id;
    form.querySelector('[data-bind="name"]').setAttribute("value", m.name);
    form.querySelector('[data-bind="fuelValue"]').setAttribute("value", m.fuelValue ?? "");
    form.querySelector('[data-bind="buyPrice"]').setAttribute("value", m.buyPrice ?? "");
    form.querySelector('[data-bind="salePrice"]').setAttribute("value", m.salePrice ?? "");
    form.querySelector('[data-bind="stackSize"]').setAttribute("value", m.stackSize ?? 1);
    if (m.isFuel) form.querySelector('[data-bind="isFuel"]').setAttribute("checked", "");
    if (m.isFertilizer) form.querySelector('[data-bind="isFertilizer"]').setAttribute("checked", "");
    if (m.isPlant) form.querySelector('[data-bind="isPlant"]').setAttribute("checked", "");
    form.querySelector('[data-bind="fertilizerNutrientValue"]').setAttribute("value", m.fertilizerNutrientValue ?? "");
    form.querySelector('[data-bind="fertilizerMaxFertility"]').setAttribute("value", m.fertilizerMaxFertility ?? "");
    form.querySelector('[data-bind="plantRequiredNutrient"]').setAttribute("value", m.plantRequiredNutrient ?? "");

    // Show/hide fertilizer and plant fields based on checkboxes
    const fertilizerFields = form.querySelector('[data-fertilizer-fields]');
    const plantField = form.querySelector('[data-plant-field]');
    if (fertilizerFields) fertilizerFields.style.display = m.isFertilizer ? "" : "none";
    if (plantField) plantField.style.display = m.isPlant ? "" : "none";

    // Calculate and display realized cost
    const realizedCost = AF.calculator.calculateRealizedCost(m.id);
    const costEl = form.querySelector('[data-bind="realizedCost"]');
    if (costEl) {
      if (Number.isFinite(realizedCost)) {
        costEl.textContent = `${realizedCost.toFixed(4)} copper coins`;
      } else {
        // Show detailed breakdown of why cost can't be calculated
        const details = AF.calculator.getCostCalculationDetails(m.id);
        let message = "Cannot calculate cost";
        if (details.reason) {
          message += `: ${details.reason}`;
        }
        if (details.producingRecipes.length > 0) {
          message += "\n\nRecipe issues:";
          details.producingRecipes.forEach(r => {
            message += `\n• ${r.recipeName}: ${r.reason || "OK"}`;
            if (r.inputs.length > 0) {
              r.inputs.forEach(inp => {
                if (!inp.canCalculate) {
                  message += `\n  - ${inp.materialName} (${inp.items}x): No cost available`;
                }
              });
            }
          });
        }
        costEl.textContent = message;
        costEl.style.whiteSpace = "pre-wrap";
      }
    }

    // Populate recipes that produce this material (in the fragment, not the form)
    const recipesList = fragment.querySelector('[data-recipes-list]');
    if (recipesList) {
      const producingRecipes = AF.state.db.recipes.filter(r =>
        r.outputs.some(out => out.materialId === m.id)
      );

      if (producingRecipes.length === 0) {
        recipesList.innerHTML = `<div class="emptyState" style="margin-top: 0;">No recipes produce this material yet.</div>`;
      } else {
        recipesList.innerHTML = producingRecipes
          .map(recipe => renderRecipeCard(recipe, m.id))
          .join("");
      }
    }

    // Create a wrapper div to convert the fragment to HTML string
    const wrapper = document.createElement('div');
    wrapper.appendChild(fragment);
    return wrapper.innerHTML;
  }

  function renderRecipeCard(recipe, contextMaterialId) {
    const template = $("#recipeCardTemplate");
    if (!template) return "";
    const card = template.content.cloneNode(true).querySelector(".recipeCard");

    const machine = recipe.machineId ? AF.core.getMachineById(recipe.machineId) : null;
    const machineName = machine ? machine.name : "(no machine)";
    const time = formatTimeString(recipe.processingTimeSec);

    card.dataset.recipeId = recipe.id;
    card.dataset.contextMaterialId = contextMaterialId;

    card.querySelector('[data-bind="recipeName"]').textContent = recipe.name;
    card.querySelector('[data-bind="recipeMeta"]').textContent = `${machineName} • ${recipe.inputs.length} in • ${recipe.outputs.length} out • ${time}`;

    // Populate the recipe form body
    const body = card.querySelector('[data-recipe-body]');
    body.innerHTML = renderRecipeForm(recipe);

    // Update delete button to reference this specific recipe
    const deleteBtn = card.querySelector('[data-action="recipe:delete"]');
    if (deleteBtn) {
      deleteBtn.dataset.recipeId = recipe.id;
    }

    return card.outerHTML;
  }

  function renderMachines() {
    const listEl = $("#machinesList");
    const editorEl = $("#machineEditor");
    const currentEl = $('[data-dropdown-toggle="machines"]');
    if (!listEl || !editorEl || !currentEl) return;

    const q = AF.state.ui.filters.machines;
    const items = filterByName([...AF.state.db.machines].sort(AF.core.compareByName), q);
    listEl.innerHTML = items
      .map((m) => {
        const selected = AF.state.ui.selected.machines === m.id ? " is-selected" : "";
        let meta = `${m.inputs} in • ${m.outputs} out`;
        if (m.kind === "heating_device") meta = furnaceMeta(m);
        if (m.kind === "storage") meta = `${m.storageSlots} slots • ${m.inputs} in • ${m.outputs} out`;
        return `
            <div class="listItem${selected}" data-kind="machines" data-id="${escapeHtml(m.id)}" tabindex="0">
              <div class="listItem__title">${escapeHtml(m.name)}</div>
              <div class="listItem__meta">${escapeHtml(meta)}</div>
            </div>
          `;
      })
      .join("");

    // Update current selection display
    const selectedId = AF.state.ui.selected.machines;
    const selected = selectedId ? AF.core.getMachineById(selectedId) : null;
    if (selected) {
      let meta = `${selected.inputs} in • ${selected.outputs} out`;
      if (selected.kind === "heating_device") meta = furnaceMeta(selected);
      if (selected.kind === "storage") meta = `${selected.storageSlots} slots • ${selected.inputs} in • ${selected.outputs} out`;
      currentEl.innerHTML = `
          <div class="dropdownSelector__selectedItem">
            <div class="dropdownSelector__selectedTitle">${escapeHtml(selected.name)}</div>
            <div class="dropdownSelector__selectedMeta">${escapeHtml(meta)}</div>
          </div>
          <div class="dropdownSelector__arrow">▼</div>
        `;
    } else {
      currentEl.innerHTML = `
          <div class="dropdownSelector__placeholder">Select a machine...</div>
          <div class="dropdownSelector__arrow">▼</div>
        `;
    }

    editorEl.innerHTML = selected ? renderMachineForm(selected) : `<div class="emptyState">Select a machine or click "Add".</div>`;
  }

  function furnaceMeta(m) {
    const baseHeat = Number.isFinite(m.baseHeatConsumptionP) ? m.baseHeatConsumptionP : 1;
    return `Furnace • ${m.inputs} in • ${m.outputs} out • Base: ${baseHeat}P/s`;
  }

  function renderSkillsBar() {
    const skillsBar = $("#skillsBar");
    if (!skillsBar) return;

    const skills = [
      { key: "conveyorSpeed", icon: "⚙️", abbr: "CVY", title: "Conveyor Speed" },
      { key: "throwingSpeed", icon: "🤚", abbr: "THR", title: "Throwing Speed" },
      { key: "machineEfficiency", icon: "🔧", abbr: "MCH", title: "Machine Efficiency" },
      { key: "alchemyEfficiency", icon: "⚗️", abbr: "ALC", title: "Alchemy Efficiency" },
      { key: "fuelEfficiency", icon: "🔥", abbr: "FUL", title: "Fuel Efficiency" },
      { key: "fertilizerEfficiency", icon: "🌱", abbr: "FRT", title: "Fertilizer Efficiency" },
      { key: "shopProfit", icon: "💰", abbr: "SHP", title: "Shop Profit" },
    ];

    skillsBar.innerHTML = skills.map(skill => {
      const value = AF.state.skills[skill.key] || 0;
      return `
          <div class="skillsBar__item" title="${skill.title}: ${value} points" data-action="edit:skills">
            <span class="skillsBar__icon">${skill.icon}</span>
            <span class="skillsBar__abbr">${skill.abbr}</span>
            <span class="skillsBar__value">${value}</span>
          </div>
        `;
    }).join("");
  }

  function renderMachineForm(m) {
    const template = $("#machineFormTemplate");
    if (!template) return "";
    const form = template.content.cloneNode(true).querySelector("form");

    const isHeatingDevice = m.kind === "heating_device";
    const isStorage = m.kind === "storage";
    const requiresFurnace = Boolean(m.requiresFurnace);

    form.dataset.id = m.id;
    form.querySelector('[data-bind="name"]').setAttribute("value", m.name);

    // Set kind select
    const kindSelect = form.querySelector('[data-bind="kind"]');
    kindSelect.querySelectorAll("option").forEach(opt => {
      if (opt.value === m.kind) opt.setAttribute("selected", "");
    });

    form.querySelector('[data-bind="inputs"]').setAttribute("value", String(m.inputs));
    form.querySelector('[data-bind="outputs"]').setAttribute("value", String(m.outputs));

    // Show/hide sections based on kind
    const stdSection = form.querySelector('[data-standard-section]');
    const heatingDeviceSection = form.querySelector('[data-heating-device-section]');
    const storageSection = form.querySelector('[data-storage-section]');

    stdSection.classList.toggle("hidden", isHeatingDevice || isStorage);
    heatingDeviceSection.classList.toggle("hidden", !isHeatingDevice);
    storageSection.classList.toggle("hidden", !isStorage);

    // Standard section fields
    if (requiresFurnace) form.querySelector('[data-bind="requiresFurnace"]').setAttribute("checked", "");
    const heatInput = form.querySelector('[data-bind="heatConsumptionP"]');
    heatInput.setAttribute("value", m.heatConsumptionP ?? "");
    if (!requiresFurnace) heatInput.setAttribute("disabled", "");
    form.querySelector('[data-bind="footprintWidth"]').setAttribute("value", String(m.footprintWidth ?? ""));
    form.querySelector('[data-bind="footprintLength"]').setAttribute("value", String(m.footprintLength ?? ""));

    // Heating Device section
    form.querySelector('[data-bind="baseHeatConsumptionP"]').setAttribute("value", String(m.baseHeatConsumptionP ?? 1));
    form.querySelector('[data-bind="heatingAreaWidth"]').setAttribute("value", String(m.heatingAreaWidth ?? ""));
    form.querySelector('[data-bind="heatingAreaLength"]').setAttribute("value", String(m.heatingAreaLength ?? ""));

    // Storage section
    form.querySelector('[data-bind="storageSlots"]').setAttribute("value", String(m.storageSlots ?? ""));

    return form.outerHTML;
  }

  function renderRecipeForm(r) {
    const template = $("#recipeFormTemplate");
    if (!template) return "";
    const form = template.content.cloneNode(true).querySelector("form");

    // Auto-populate inputs/outputs based on selected machine
    const machine = r.machineId ? AF.core.getMachineById(r.machineId) : null;
    const numInputs = machine ? machine.inputs : 1;
    const numOutputs = machine ? machine.outputs : 1;

    // Pad or truncate to match machine spec
    const inputs = [];
    for (let i = 0; i < numInputs; i++) {
      inputs.push(r.inputs[i] || { materialId: "", items: 0 });
    }
    const outputs = [];
    for (let i = 0; i < numOutputs; i++) {
      outputs.push(r.outputs[i] || { materialId: "", items: 0 });
    }

    form.dataset.id = r.id;
    form.querySelector('[data-bind="name"]').setAttribute("value", r.name);
    form.querySelector('[data-bind="processingTimeSec"]').setAttribute("value", formatTimeString(r.processingTimeSec));
    form.querySelector('[data-bind="heatConsumptionP"]').setAttribute("value", r.heatConsumptionP ?? "");

    // Populate machine options
    const machineSelect = form.querySelector('[data-bind="machineId"]');
    populateMachineOptions(machineSelect, r.machineId);

    // Populate I/O rows
    const inputsList = form.querySelector('[data-io-list="inputs"]');
    const outputsList = form.querySelector('[data-io-list="outputs"]');

    inputs.forEach((io, idx) => {
      const row = renderIoRowElement("inputs", idx, io, r.processingTimeSec);
      inputsList.appendChild(row);
    });

    outputs.forEach((io, idx) => {
      const row = renderIoRowElement("outputs", idx, io, r.processingTimeSec);
      outputsList.appendChild(row);
    });

    return form.outerHTML;
  }

  function renderIoRowElement(kind, idx, io, processingTimeSec) {
    const template = $("#ioRowTemplate");
    if (!template) return document.createElement("div");
    const row = template.content.cloneNode(true).querySelector(".ioRow");

    const items = io.items ?? 0;
    const rate = processingTimeSec > 0 ? (items / processingTimeSec * 60).toFixed(2) : 0;

    row.dataset.ioRow = kind;
    row.dataset.idx = idx;

    const materialSelect = row.querySelector('[data-bind="materialId"]');
    materialSelect.name = `${kind}[${idx}].materialId`;
    populateMaterialOptions(materialSelect, io.materialId);

    const itemsInput = row.querySelector('[data-bind="items"]');
    itemsInput.name = `${kind}[${idx}].items`;
    itemsInput.setAttribute("value", String(items));

    row.querySelector('[data-bind="rateHint"]').textContent = `${rate} per minute`;

    return row;
  }

  // Populate a <select> element with material options (DOM-based)
  function populateMaterialOptions(selectEl, selectedId = "") {
    const mats = [...AF.state.db.materials].sort(AF.core.compareByName);
    mats.forEach((m) => {
      const option = document.createElement("option");
      option.value = m.id;
      option.textContent = m.name;
      if (m.id === selectedId) option.setAttribute("selected", "");
      selectEl.appendChild(option);
    });
  }

  // Populate a <select> element with machine options (DOM-based)
  function populateMachineOptions(selectEl, selectedId = "") {
    const macs = [...AF.state.db.machines].sort(AF.core.compareByName);
    macs.forEach((m) => {
      const option = document.createElement("option");
      option.value = m.id;
      const suffix =
        m.kind === "heating_device"
          ? " (Heating Device)"
          : m.kind === "storage"
            ? " (Storage)"
            : m.requiresFurnace
              ? " (requires Heating Device)"
              : "";
      option.textContent = m.name + suffix;
      if (m.id === selectedId) option.setAttribute("selected", "");
      selectEl.appendChild(option);
    });
  }


  function renderBlueprintSelectionList(filter = "") {
    const listEl = $("#blueprintSelectionList");
    if (!listEl) return;

    const filteredBlueprints = AF.state.db.blueprints.filter(bp =>
      !filter || bp.name.toLowerCase().includes(filter.toLowerCase())
    );

    if (filteredBlueprints.length === 0) {
      listEl.innerHTML = '<div class="emptyState">No blueprints found.</div>';
      return;
    }

    listEl.innerHTML = filteredBlueprints.map(bp => {
      const machineCount = bp.machines.length;
      return `
        <div class="storageTypeItem" data-blueprint-select-id="${bp.id}">
          <div class="storageTypeItem__name">📐 ${escapeHtml(bp.name)}</div>
          <div class="storageTypeItem__meta">${machineCount} machine${machineCount !== 1 ? 's' : ''} • ${bp.inputs.length} in / ${bp.outputs.length} out</div>
        </div>
      `;
    }).join('');
  }


  /**
   * Render blueprint list in sidebar
   */
  function renderBlueprintsList() {
    const listEl = $("#blueprintsList");
    if (!listEl) return;

    if (!AF.state.db.blueprints || AF.state.db.blueprints.length === 0) {
      listEl.innerHTML = '<div class="emptyState">No blueprints yet. Select machines and click 📐 to create one.</div>';
      return;
    }

    listEl.innerHTML = AF.state.db.blueprints.map(bp => {
      const machineCount =
        AF.state.calc?.blueprintMachineCounts?.get?.(bp.id) ??
        { totalCount: (bp.machines || []).length, breakdown: {} };

      // Build inputs HTML
      const inputsHTML = (bp.inputs || []).map(input => {
        const isFuel = input && (input.kind === "fuel" || input.materialId == null);
        const material = !isFuel ? AF.core.getMaterialById(input.materialId) : null;
        const materialName = isFuel ? "Fuel" : (material ? material.name : "Unknown");
        const rateStr = isFuel
          ? `${Number(input.rate || 0).toFixed(1)}P`
          : `${input.rate.toFixed(2)}/min`;
        return `
          <div class="blueprintCard__ioItem">
            <span class="blueprintCard__ioIcon">📥</span>
            <span>${escapeHtml(materialName)}: ${rateStr}</span>
          </div>
        `;
      }).join('');

      // Build outputs HTML
      const outputsHTML = (bp.outputs || []).map(output => {
        const material = AF.core.getMaterialById(output.materialId);
        const materialName = material ? material.name : "Unknown";
        return `
          <div class="blueprintCard__ioItem">
            <span class="blueprintCard__ioIcon">📤</span>
            <span>${escapeHtml(materialName)}: ${output.rate.toFixed(2)}/min</span>
          </div>
        `;
      }).join('');

      // Build machine breakdown HTML
      const breakdownItems = [];
      for (const machineKey in machineCount.breakdown) {
        const count = machineCount.breakdown[machineKey];
        let machineName = "Unknown";

        if (machineKey === "purchasing_portal") {
          machineName = "Purchasing Portal";
        } else if (machineKey === "nursery") {
          machineName = "Nursery";
        } else if (machineKey === "unknown") {
          machineName = "Unknown Machine";
        } else {
          const machine = AF.core.getMachineById(machineKey);
          machineName = machine ? machine.name : "Unknown Machine";
        }

        breakdownItems.push({ name: machineName, count });
      }

      // Sort by count descending, then by name
      breakdownItems.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });

      const breakdownHTML = breakdownItems.map(item => `
        <div style="display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px;">
          <span>${escapeHtml(item.name)}</span>
          <span style="font-weight: 600; color: var(--accent);">×${item.count}</span>
        </div>
      `).join('');

      return `
        <div class="blueprintCard" data-blueprint-id="${bp.id}" draggable="true">
          <div class="blueprintCard__header" style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
            <div class="blueprintCard__name">${escapeHtml(bp.name)}</div>
            <div style="display:flex; gap: 4px; align-items: center;">
              <button class="btn btn--sm" data-action="blueprint:add-items-to-canvas" data-blueprint-add-items-id="${bp.id}" title="Add blueprint items to canvas" style="padding: 2px 6px; font-size: 11px;">＋</button>
              <button class="btn btn--sm" data-action="blueprint:edit-as-copy" data-blueprint-edit-copy-id="${bp.id}" title="Edit blueprint (save as copy)" style="padding: 2px 6px; font-size: 11px;">✎</button>
              <button class="btn btn--danger btn--sm" data-action="blueprint:delete" data-blueprint-delete-id="${bp.id}" title="Delete Blueprint" style="padding: 2px 6px; font-size: 11px;">✕</button>
            </div>
          </div>
          ${bp.description ? `<div class="blueprintCard__description">${escapeHtml(bp.description)}</div>` : ''}
          <div class="blueprintCard__stats">
            <span>🏭 ${machineCount.totalCount} machine${machineCount.totalCount !== 1 ? 's' : ''}</span>
          </div>
          ${breakdownHTML ? `
            <details class="blueprintCard__breakdown">
              <summary style="cursor: pointer; font-size: 11px; color: var(--muted); margin-top: 8px; user-select: none;">
                ▸ Show machine breakdown
              </summary>
              <div style="margin-top: 6px; padding: 8px; background: rgba(0,0,0,.2); border-radius: 6px;">
                ${breakdownHTML}
              </div>
            </details>
          ` : ''}
          ${inputsHTML || outputsHTML ? `
            <div class="blueprintCard__io">
              ${inputsHTML ? `
                <div class="blueprintCard__ioSection">
                  <div class="blueprintCard__ioTitle">Inputs</div>
                  <div class="blueprintCard__ioList">${inputsHTML}</div>
                </div>
              ` : ''}
              ${outputsHTML ? `
                <div class="blueprintCard__ioSection">
                  <div class="blueprintCard__ioTitle">Outputs</div>
                  <div class="blueprintCard__ioList">${outputsHTML}</div>
                </div>
              ` : ''}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    // Add drag handlers
    listEl.querySelectorAll('.blueprintCard').forEach(card => {
      card.addEventListener('dragstart', (e) => {
        // Don't start drag if clicking action buttons
        if (e.target.closest('[data-action="blueprint:delete"], [data-action="blueprint:add-items-to-canvas"], [data-action="blueprint:edit-as-copy"]')) {
          e.preventDefault();
          return;
        }

        const blueprintId = card.dataset.blueprintId;
        e.dataTransfer.setData('blueprintId', blueprintId);
        e.dataTransfer.effectAllowed = 'copy';
      });

      // Prevent action buttons from triggering drag
      card.querySelectorAll('[data-action="blueprint:delete"], [data-action="blueprint:add-items-to-canvas"], [data-action="blueprint:edit-as-copy"]').forEach(btn => {
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
      });
    });
  }

  function renderStorageTypesList() {
    const list = $("#storageTypesList");
    if (!list) return;

    const storageMachines = AF.state.db.machines.filter(m => m.kind === "storage");

    if (storageMachines.length === 0) {
      list.innerHTML = '<div class="emptyState">No storage machines configured.<br>Add a storage machine in the Machines tab first.</div>';
      return;
    }

    list.innerHTML = `
      <div class="storageTypesList">
        ${storageMachines.map(machine => `
          <div class="storageTypeItem" data-storage-machine-id="${machine.id}">
            <div class="storageTypeItem__name">${escapeHtml(machine.name)}</div>
            <div class="storageTypeItem__meta">${machine.storageSlots} slots • ${machine.inputs} in • ${machine.outputs} out</div>
          </div>
        `).join("")}
      </div>
    `;
  }


  function renderProductionSummary() {
    const summary = $("#productionSummary");
    if (!summary) return;

    // Render uses precomputed snapshot only (no calculation here)
    const calc = AF.state.calc || {};
    const sources = Array.isArray(calc.sources) ? calc.sources : [];
    const sinks = Array.isArray(calc.sinks) ? calc.sinks : [];
    const netProduction = calc.netProduction || { exports: new Map(), imports: new Map() };

    // If canvas is empty (or not yet calculated), show empty state
    const exportsMap = netProduction.exports || new Map();
    const importsMap = netProduction.imports || new Map();
    if (sources.length === 0 && sinks.length === 0 && exportsMap.size === 0 && importsMap.size === 0) {
      summary.innerHTML = `
        <div class="productionSection">
          <div class="hint">Canvas is empty. Add machines to see production summary.</div>
        </div>
      `;
      return;
    }

    let html = "";

    // Source machines (no inputs - producing from internal/infinite sources)
    if (sources.length > 0) {
      html += `<div class="productionSection">
        <div class="productionSection__title">🔧 Production Sources</div>`;
      sources.forEach(pm => {
        const machine = pm.machineId ? AF.core.getMachineById(pm.machineId) : null;
        let name = "Unknown";
        if (pm.type === "purchasing_portal") {
          const mat = pm.materialId ? AF.core.getMaterialById(pm.materialId) : null;
          name = `Purchasing Portal${mat ? ` (${mat.name})` : ''}`;
        } else if (pm.type === "nursery") {
          const plant = pm.plantId ? AF.core.getMaterialById(pm.plantId) : null;
          name = `Nursery${plant ? ` (${plant.name})` : ''}`;
        } else if (pm.type === "blueprint_instance" || pm.type === "blueprint") {
          name = pm.name || pm.blueprintData?.name || "Blueprint";
        } else if (machine) {
          name = machine.kind === "storage" ? `${machine.name} (Storage)` : machine.name;
        }
        html += `<div class="productionItem">• ${escapeHtml(name)} ${pm.count > 1 ? `(×${pm.count})` : ''}</div>`;
      });
      html += `</div>`;
    }

    // Sink machines (exported materials / void production)
    if (sinks.length > 0) {
      html += `<div class="productionSection">
        <div class="productionSection__title">📦 Exported Materials (Sink)</div>`;
      sinks.forEach(pm => {
        const machine = pm.machineId ? AF.core.getMachineById(pm.machineId) : null;
        let name = "Unknown";
        let prefix = "•";

        // Check if this machine is inside a blueprint
        if (pm._isChildMachine && pm._parentBlueprintId) {
          prefix = "📦"; // Blueprint icon for child machines
        }

        if (pm.type === "purchasing_portal") name = "Purchasing Portal";
        else if (pm.type === "nursery") {
          const plant = pm.plantId ? AF.core.getMaterialById(pm.plantId) : null;
          name = `Nursery${plant ? ` (${plant.name})` : ''}`;
        } else if (pm.type === "blueprint_instance" || pm.type === "blueprint") {
          name = pm.name || pm.blueprintData?.name || "Blueprint";
        } else if (machine) {
          name = machine.kind === "storage" ? `${machine.name} (Storage)` : machine.name;
        }
        html += `<div class="productionItem">${prefix} ${escapeHtml(name)} ${pm.count > 1 ? `(×${pm.count})` : ''}</div>`;
      });
      html += `</div>`;
    }

    // Net Imports/Exports
    html += `<div class="productionSection">
      <div class="productionSection__title">📊 Net Imports / Exports</div>`;

    if (exportsMap.size === 0 && importsMap.size === 0) {
      const stabilityWarning = calc.stabilityWarning || null;
      if (stabilityWarning) {
        html += `<div class="hint" style="color: #ffa500; font-weight: 600;">${escapeHtml(stabilityWarning)}</div>`;
      } else {
        html += `<div class="hint">✅ All materials are balanced - fully self-contained production.</div>`;
      }
    } else {
      // Sort exports by rate (descending)
      const exportEntries = Array.from(exportsMap.entries())
        .filter(([_, rate]) => rate > 0.01)
        .sort((a, b) => b[1] - a[1]);

      // Sort imports by rate (descending)
      const importEntries = Array.from(importsMap.entries())
        .filter(([_, rate]) => rate > 0.01)
        .sort((a, b) => b[1] - a[1]);

      if (exportEntries.length > 0) {
        html += `<div style="margin-bottom: 8px; font-weight: 600; color: var(--ok);">📤 Exports:</div>`;
        exportEntries.forEach(([materialId, rate]) => {
          const material = AF.core.getMaterialById(materialId);
          const name = material ? material.name : "(unknown)";
          const rateFormatted = rate.toFixed(2);
          html += `<div class="productionItem" style="color: var(--ok); padding-left: 12px;">
            ${escapeHtml(name)}: +${rateFormatted}/min
          </div>`;
        });
      }

      if (importEntries.length > 0) {
        html += `<div style="margin-bottom: 8px; margin-top: ${exportEntries.length > 0 ? '12px' : '0'}; font-weight: 600; color: var(--danger);">📥 Imports Required:</div>`;
        importEntries.forEach(([materialId, rate]) => {
          const material = AF.core.getMaterialById(materialId);
          const name = material ? material.name : "(unknown)";
          const rateFormatted = rate.toFixed(2);
          html += `<div class="productionItem" style="color: var(--danger); padding-left: 12px;">
            ${escapeHtml(name)}: ${rateFormatted}/min
          </div>`;
        });
      }

      if (exportEntries.length === 0 && importEntries.length === 0) {
        const stabilityWarning = calc.stabilityWarning || null;
        if (stabilityWarning) {
          html += `<div class="hint" style="color: #ffa500; font-weight: 600;">${escapeHtml(stabilityWarning)}</div>`;
        } else {
          html += `<div class="hint">✅ All materials are balanced - fully self-contained production.</div>`;
        }
      }
    }
    html += `</div>`;

    // Storage fill times (precomputed)
    const storageFillItems = Array.isArray(calc.storageFillItems) ? calc.storageFillItems : [];
    if (storageFillItems.length > 0) {
      html += `<div class="productionSection">
        <div class="productionSection__title">Storage Fill Times</div>`;

      storageFillItems.forEach(item => {
        const timeStr = formatTimeMinutes(item.timeToFillMinutes);
        html += `<div class="productionItem">
          <strong>${escapeHtml(item.storageName)}</strong> - ${escapeHtml(item.materialName)}: 
          <span style="color: var(--ok);">Fills in ${timeStr}</span> 
          <span style="color: var(--muted); font-size: 10px;">@ ${item.inputRate.toFixed(2)}/min</span>
        </div>`;
      });

      html += `</div>`;
    }

    // Purchasing costs (coin consumption from purchasing portals + imports)
    const purchasingCosts = calc.purchasingCosts || { totalCopper: 0, breakdown: new Map() };
    // Use the importsMap already declared above

    const importCosts = calc.importCosts || new Map();
    const totalImportCost = Number(calc.totalImportCost) || 0;
    const totalCost = Number(calc.totalCost) || (Number(purchasingCosts.totalCopper) || 0) + totalImportCost;

    if (totalCost > 0) {
      html += `<div class="productionSection">
        <div class="productionSection__title">💰 Purchasing Costs</div>`;

      // Show purchasing portal costs
      if (purchasingCosts.totalCopper > 0) {
        html += `<div style="margin-bottom: 8px; font-weight: 600; color: var(--muted);">From Purchasing Portals:</div>`;

        const costEntries = Array.from(purchasingCosts.breakdown.entries())
          .sort((a, b) => b[1].costPerMinute - a[1].costPerMinute);

        costEntries.forEach(([materialId, data]) => {
          const costStr = formatCoins(data.costPerMinute);
          html += `<div class="productionItem" style="padding-left: 12px;">
            <strong>${escapeHtml(data.material.name)}</strong>: ${data.rate.toFixed(2)}/min
            <span style="color: var(--danger); margin-left: 8px;">-${costStr}/min</span>
          </div>`;
        });
      }

      // Show import costs
      if (importCosts.size > 0) {
        html += `<div style="margin-bottom: 8px; margin-top: ${purchasingCosts.totalCopper > 0 ? '12px' : '0'}; font-weight: 600; color: var(--muted);">From Imports (Realised Cost):</div>`;

        const importEntries = Array.from(importCosts.entries())
          .sort((a, b) => b[1].costPerMinute - a[1].costPerMinute);

        importEntries.forEach(([materialId, data]) => {
          const costStr = formatCoins(data.costPerMinute);
          html += `<div class="productionItem" style="padding-left: 12px;">
            <strong>${escapeHtml(data.material.name)}</strong>: ${data.rate.toFixed(2)}/min @ ${data.realizedCost.toFixed(2)}c/unit
            <span style="color: var(--danger); margin-left: 8px;">-${costStr}/min</span>
          </div>`;
        });
      }

      // Show total
      const totalCostStr = formatCoins(totalCost);
      html += `<div class="productionItem" style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); font-weight: bold;">
        Total Cost: <span style="color: var(--danger);">-${totalCostStr}/min</span>
      </div>`;

      html += `</div>`;
    }

    summary.innerHTML = html;
  }


  function openStorageSelectionDialog(x, y) {
    const storageMachines = AF.state.db.machines.filter(m => m.kind === "storage");

    if (storageMachines.length === 0) {
      setStatus("No storage machines configured. Add a storage machine first.", "error");
      return;
    }

    // Store coordinates for later use
    AF.state.ui.pendingStorageCoords = { x, y };

    renderStorageTypesList();

    const dialog = $("#storageSelectionDialog");
    if (dialog) {
      // Ensure dialog title is set for adding mode
      const title = dialog.querySelector(".dialog__title");
      if (title) title.textContent = "Select Storage Type";
      dialog.classList.remove("hidden");
    }
  }

  function openBlueprintSelectionDialog(x, y) {
    if (AF.state.db.blueprints.length === 0) {
      setStatus("No blueprints available. Create a blueprint first.", "error");
      return;
    }

    // Store coordinates for later use
    AF.state.ui.pendingBlueprintCoords = { x, y };

    renderBlueprintSelectionList();

    const dialog = $("#blueprintSelectionDialog");
    if (dialog) {
      dialog.classList.remove("hidden");
      // Focus search input
      const searchInput = dialog.querySelector("#blueprintSelectionSearch");
      if (searchInput) {
        searchInput.value = "";
        searchInput.focus();
      }
    }
  }

  function openManualStorageDialog(machineId) {
    // Store the machine ID for later use
    AF.state.ui.pendingManualStorageMachineId = machineId;

    const placedMachine = AF.state.build.placedMachines.find(pm => pm.id === machineId);
    if (!placedMachine) return;

    const machine = AF.core.getMachineById(placedMachine.machineId);
    if (!machine || machine.kind !== "storage") return;

    const maxSlots = placedMachine.storageSlots || machine.storageSlots;
    const manualInventories = placedMachine.manualInventories || [];
    const usedSlots = manualInventories.reduce((sum, inv) => sum + (inv.slotsAllocated || 0), 0);
    const availableSlots = maxSlots - usedSlots;

    if (availableSlots <= 0) {
      setStatus("Storage is full. Remove a material first.", "error");
      return;
    }

    // Populate material options
    const form = $("#manualStorageForm");
    if (!form) return;

    const select = form.querySelector("select[name='materialId']");
    if (select) {
      const materialOptions = AF.state.db.materials.map(m =>
        `<option value="${m.id}">${escapeHtml(m.name)}</option>`
      ).join("");
      select.innerHTML = `<option value="">(select material)</option>${materialOptions}`;
    }

    // Set max slots
    const slotsInput = form.querySelector("input[name='slotsAllocated']");
    if (slotsInput) {
      slotsInput.setAttribute("max", String(availableSlots));
      slotsInput.value = "1";
    }

    // Reset form
    form.reset();
    form.querySelector("input[name='currentAmount']").value = "0";

    const dialog = $("#manualStorageDialog");
    if (dialog) dialog.classList.remove("hidden");
  }

  function openStorageTypeChangeDialog(placedMachineId) {
    const storageMachines = AF.state.db.machines.filter(m => m.kind === "storage");

    if (storageMachines.length === 0) {
      setStatus("No storage machines configured.", "error");
      return;
    }

    // Store the machine ID we're replacing
    AF.state.ui.pendingStorageReplacementId = placedMachineId;

    renderStorageTypesList();

    const dialog = $("#storageSelectionDialog");
    if (dialog) {
      // Update dialog title for replacement mode
      const title = dialog.querySelector(".dialog__title");
      if (title) title.textContent = "Change Storage Type";
      dialog.classList.remove("hidden");
    }
  }


  function openSkillsDialog() {
    const dialog = $("#skillsDialog");
    if (!dialog) return;

    renderSkillsList();
    dialog.classList.remove("hidden");

    // Close on overlay click
    const overlay = dialog.querySelector(".dialog__overlay");
    if (overlay) {
      overlay.onclick = closeDialog;
    }
  }

  function closeDialog() {
    // Close system dialog (if open) first so awaiting callers resolve.
    AF.ui?.dialog?.close?.();
    const skillsDialog = $("#skillsDialog");
    const productionDialog = $("#productionDialog");
    const jumpDialog = $("#jumpToCoordinatesDialog");
    const storageDialog = $("#storageSelectionDialog");
    const manualStorageDialog = $("#manualStorageDialog");
    const topperDialog = $("#addTopperDialog");
    const blueprintDialog = $("#createBlueprintDialog");
    const blueprintSelectDialog = $("#blueprintSelectionDialog");
    const costSettingsDialog = $("#costSettingsDialog");
    if (skillsDialog) skillsDialog.classList.add("hidden");
    if (productionDialog) productionDialog.classList.add("hidden");
    if (jumpDialog) jumpDialog.classList.add("hidden");
    if (storageDialog) {
      storageDialog.classList.add("hidden");
      // Reset title to default
      const title = storageDialog.querySelector(".dialog__title");
      if (title) title.textContent = "Select Storage Type";
    }
    if (manualStorageDialog) manualStorageDialog.classList.add("hidden");
    if (topperDialog) topperDialog.classList.add("hidden");
    if (blueprintDialog) blueprintDialog.classList.add("hidden");
    if (blueprintSelectDialog) blueprintSelectDialog.classList.add("hidden");
    if (costSettingsDialog) costSettingsDialog.classList.add("hidden");

    // Clear pending state
    AF.state.ui.pendingStorageReplacementId = null;
    AF.state.ui.pendingHeatingDeviceId = null;
    AF.state.ui.pendingBlueprintCoords = null;
  }


  async function replaceStorageType(placedMachineId, newMachineId) {
    const placedMachine = AF.state.build.placedMachines.find(pm => pm.id === placedMachineId);
    if (!placedMachine) {
      setStatus("Machine not found.", "error");
      return;
    }

    const oldMachine = AF.core.getMachineById(placedMachine.machineId);
    const newMachine = AF.core.getMachineById(newMachineId);

    if (!oldMachine || !newMachine || oldMachine.kind !== "storage" || newMachine.kind !== "storage") {
      setStatus("Invalid storage machine.", "error");
      return;
    }

    // Check if manual inventories can fit in new storage
    const manualInventories = placedMachine.manualInventories || [];
    if (manualInventories.length > 0) {
      const totalSlotsNeeded = manualInventories.reduce((sum, inv) => sum + (inv.slotsAllocated || 0), 0);

      if (totalSlotsNeeded > newMachine.storageSlots) {
        const proceed = await AF.ui.dialog.confirm(
          `Warning: The new storage has ${newMachine.storageSlots} slots, but the current storage is using ${totalSlotsNeeded} slots.\n\n` +
          `Changing to this storage will result in data loss. Do you want to continue?`,
          { title: "Data loss warning", danger: true }
        );
        if (!proceed) return;

        // Clear manual inventories if user proceeds
        placedMachine.manualInventories = [];
      }
    }

    // Update to new machine type
    placedMachine.machineId = newMachineId;
    placedMachine.storageSlots = Math.min(
      placedMachine.storageSlots || newMachine.storageSlots,
      newMachine.storageSlots
    );

    // Reset dialog title back to default
    const dialog = $("#storageSelectionDialog");
    if (dialog) {
      const title = dialog.querySelector(".dialog__title");
      if (title) title.textContent = "Select Storage Type";
    }

    AF.core?.saveBuild?.();
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true });
    setStatus(`Storage changed to ${newMachine.name}.`);
  }


  function saveBlueprintFromDialog() {
    const nameInput = $("#blueprintName");
    const descInput = $("#blueprintDescription");

    if (!nameInput) return;

    const name = nameInput.value.trim();
    if (!name) {
      setStatus("Blueprint name is required.", "error");
      nameInput.focus();
      return;
    }

    const description = descInput?.value.trim() || "";
    // Get the analysis again
    const analysis = AF.calculator.analyzeBlueprintMachines(AF.state.build.selectedMachines);

    // Deep copy the machines (excluding their x, y positions - we'll calculate relative positions)
    const firstMachine = analysis.machines[0];
    const originX = firstMachine.x;
    const originY = firstMachine.y;

    // Create a mapping from current IDs to blueprint template IDs
    const idToBlueprintId = new Map();

    const machines = analysis.machines.map((pm, idx) => {
      // Deep copy machine data
      const copy = JSON.parse(JSON.stringify(pm));
      // Store relative position from first machine
      copy.x = pm.x - originX;
      copy.y = pm.y - originY;
      // Use a sequential ID for blueprint template
      const blueprintId = `bpm_${idx}`;
      idToBlueprintId.set(pm.id, blueprintId);
      copy.blueprintMachineId = blueprintId;
      delete copy.id; // Will be assigned when placed
      return copy;
    });

    // Deep copy connections between selected machines with mapped IDs
    const selectedSet = new Set(AF.state.build.selectedMachines);
    const connections = AF.state.build.connections
      .filter(conn => selectedSet.has(conn.fromMachineId) && selectedSet.has(conn.toMachineId))
      .map(conn => {
        return {
          fromMachineId: idToBlueprintId.get(conn.fromMachineId),
          fromPortIdx: conn.fromPortIdx,
          toMachineId: idToBlueprintId.get(conn.toMachineId),
          toPortIdx: conn.toPortIdx,
        };
      });

    // Transform analysis inputs/outputs into blueprint IO specs.
    // Special case: fuel inputs store a direct mapping hint to the internal heating device fuel port.
    const inputs = (analysis.inputs || []).map(inp => {
      if (inp && (inp.kind === "fuel" || (inp.materialId == null && inp.internalPortIdx === "fuel"))) {
        return {
          materialId: null,
          rate: Number(inp.rate) || 0,
          kind: "fuel",
          internalBlueprintMachineId: idToBlueprintId.get(inp.internalMachineId),
          internalPortIdx: "fuel",
        };
      }
      return {
        materialId: inp.materialId,
        rate: Number(inp.rate) || 0,
        kind: "material",
      };
    });

    const outputs = (analysis.outputs || []).map(out => ({
      materialId: out.materialId,
      rate: Number(out.rate) || 0,
      kind: "material",
    }));

    // Create blueprint object
    const blueprint = {
      id: makeId("bp"),
      name,
      description,
      machines,
      connections,
      inputs,
      outputs,
      createdAt: new Date().toISOString(),
    };

    // Add to database
    AF.state.db.blueprints.push(blueprint);

    // Invalidate cache since we added a new blueprint
    AF.calculator?.invalidateBlueprintCountCache?.(blueprint.id);

    AF.core.saveDb();
    AF.render?.renderBlueprintsList?.();

    // Replace selected machines with blueprint instance
    replaceSelectionWithBlueprint(blueprint, selectedSet, analysis);

    closeDialog();
    setStatus(`Blueprint "${name}" created and placed on canvas.`);
  }

  function replaceSelectionWithBlueprint(blueprint, selectedSet, analysis) {
    // Calculate center position of selected machines
    const selectedMachines = AF.state.build.placedMachines.filter(pm => selectedSet.has(pm.id));
    if (selectedMachines.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    selectedMachines.forEach(pm => {
      minX = Math.min(minX, pm.x);
      minY = Math.min(minY, pm.y);
      maxX = Math.max(maxX, pm.x + 300); // Approximate machine width
      maxY = Math.max(maxY, pm.y + 200); // Approximate machine height
    });

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Find external connections (connections crossing the selection boundary)
    // IMPORTANT: Capture material IDs BEFORE deleting machines
    const externalConnections = [];
    AF.state.build.connections.forEach(conn => {
      const fromInside = selectedSet.has(conn.fromMachineId);
      const toInside = selectedSet.has(conn.toMachineId);

      if (fromInside !== toInside) {
        // Connection crosses boundary - capture material ID now
        let materialId = null;

        if (fromInside) {
          // Output connection - get material from source machine (inside)
          const sourceMachine = AF.state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
          if (sourceMachine) {
            materialId = AF.core.getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
          }
        } else {
          // Input connection - get material from source machine (outside)
          const sourceMachine = AF.state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
          if (sourceMachine) {
            materialId = AF.core.getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
          }
        }

        externalConnections.push({
          ...conn,
          fromInside,
          toInside,
          materialId // Store material ID for reconnection
        });
      }
    });

    // Remove connections to/from selected machines
    AF.state.build.connections = AF.state.build.connections.filter(conn =>
      !selectedSet.has(conn.fromMachineId) && !selectedSet.has(conn.toMachineId)
    );

    // Remove selected machines
    AF.state.build.placedMachines = AF.state.build.placedMachines.filter(pm => !selectedSet.has(pm.id));

    // Add blueprint instance using the SAME code path as dragging from panel
    // This ensures consistency and uses the new physical instance model
    placeBlueprintOnCanvas(blueprint.id, centerX - 150, centerY - 100);

    // Get the newly created blueprint instance (it's the last one added)
    const blueprintInstance = AF.state.build.placedMachines[AF.state.build.placedMachines.length - 1];

    // Try to reconnect external connections to blueprint ports
    reconnectExternalConnectionsToBlueprint(externalConnections, blueprintInstance, selectedSet);

    // Clear selection
    AF.state.build.selectedMachines = [blueprintInstance.id];

    AF.core.saveBuild();
    AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true });
    updateSelectionClasses();
  }

  function reconnectExternalConnectionsToBlueprint(externalConnections, blueprintInstance, originalSelectedSet) {
    // Get blueprint definition to check inputs/outputs
    const blueprint = AF.state.db.blueprints.find(bp => bp.id === blueprintInstance.blueprintId);
    if (!blueprint) return;

    externalConnections.forEach(conn => {
      if (!conn.materialId) return; // Skip if we couldn't determine material

      if (conn.toInside) {
        // Connection FROM outside TO inside (blueprint input)
        const sourceMachine = AF.state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
        if (!sourceMachine) return;

        // Find matching blueprint input port by material ID
        const inputIndex = blueprint.inputs.findIndex(inp => inp.materialId === conn.materialId);
        if (inputIndex >= 0) {
          // Create new connection to blueprint input
          AF.state.build.connections.push({
            id: makeId("conn"),
            fromMachineId: conn.fromMachineId,
            fromPortIdx: conn.fromPortIdx,
            toMachineId: blueprintInstance.id,
            toPortIdx: String(inputIndex),
          });
          console.log(`Reconnected input: ${AF.core.getMaterialById(conn.materialId)?.name} from ${conn.fromMachineId} to blueprint port ${inputIndex}`);
        }
      } else if (conn.fromInside) {
        // Connection FROM inside TO outside (blueprint output)
        const targetMachine = AF.state.build.placedMachines.find(pm => pm.id === conn.toMachineId);
        if (!targetMachine) return;

        // Find matching blueprint output port by material ID (captured before deletion)
        const outputIndex = blueprint.outputs.findIndex(out => out.materialId === conn.materialId);

        if (outputIndex >= 0) {
          // Create new connection from blueprint output
          AF.state.build.connections.push({
            id: makeId("conn"),
            fromMachineId: blueprintInstance.id,
            fromPortIdx: String(outputIndex),
            toMachineId: conn.toMachineId,
            toPortIdx: conn.toPortIdx,
          });
          console.log(`Reconnected output: ${AF.core.getMaterialById(conn.materialId)?.name} from blueprint port ${outputIndex} to ${conn.toMachineId}`);
        }
      }
    });
  }


  function enterBlueprintEditMode(instanceId) {
    const placedMachine = AF.state.build.placedMachines.find(pm => pm.id === instanceId);
    if (!placedMachine || (placedMachine.type !== "blueprint" && placedMachine.type !== "blueprint_instance")) return;

    // Push current canvas state to stack (including current edit context if nested)
    AF.state.blueprintEditStack.push({
      placedMachines: JSON.parse(JSON.stringify(AF.state.build.placedMachines)),
      connections: JSON.parse(JSON.stringify(AF.state.build.connections)),
      camera: { ...state.build.camera },
      selectedMachines: [...state.build.selectedMachines],
      editContext: AF.state.currentBlueprintEdit ? JSON.parse(JSON.stringify(AF.state.currentBlueprintEdit)) : null,
    });

    let machines, connections, blueprintName, blueprintId, detached, originalBlueprint;

    // Check if using new physical model
    if (placedMachine.type === "blueprint_instance" && placedMachine.childMachines) {
      // New model - load child machines directly
      blueprintName = placedMachine.name;
      blueprintId = placedMachine.blueprintId;
      detached = placedMachine.detached || false;

      // Get original blueprint for comparison (if not detached)
      originalBlueprint = blueprintId && !detached
        ? AF.state.db.blueprints.find(bp => bp.id === blueprintId)
        : null;

      // Generate new temporary IDs for editing (map back on save)
      const idMap = new Map();
      machines = placedMachine.childMachines.map(childMachine => {
        const newId = makeId("pm");
        idMap.set(childMachine.id, newId);

        const machine = JSON.parse(JSON.stringify(childMachine));
        machine.id = newId;
        // Remove internal flags for editing
        delete machine._parentBlueprintId;
        delete machine._isChildMachine;
        return machine;
      });

      // Remap connections
      connections = placedMachine.childConnections.map(childConn => {
        return {
          id: makeId("conn"),
          fromMachineId: idMap.get(childConn.fromMachineId),
          fromPortIdx: childConn.fromPortIdx,
          toMachineId: idMap.get(childConn.toMachineId),
          toPortIdx: childConn.toPortIdx,
        };
      });

      AF.state.currentBlueprintEdit = {
        instanceId: instanceId,
        blueprintId: blueprintId,
        detached: detached,
        originalBlueprint: originalBlueprint ? JSON.parse(JSON.stringify(originalBlueprint)) : null,
        childIdMap: idMap // Keep for reverse mapping on save
      };
    } else {
      // Old model - load from blueprint definition
      const blueprint = AF.state.db.blueprints.find(bp => bp.id === placedMachine.blueprintId);
      if (!blueprint) {
        setStatus("Blueprint definition not found.", "error");
        return;
      }

      blueprintName = blueprint.name;
      blueprintId = blueprint.id;
      detached = false;
      originalBlueprint = blueprint;

      // Generate new IDs for editing
      const idMap = new Map();
      machines = blueprint.machines.map(templateMachine => {
        const newId = makeId("pm");
        idMap.set(templateMachine.blueprintMachineId, newId);

        const machine = JSON.parse(JSON.stringify(templateMachine));
        machine.id = newId;
        return machine;
      });

      connections = (blueprint.connections || []).map(templateConn => {
        return {
          id: makeId("conn"),
          fromMachineId: idMap.get(templateConn.fromMachineId),
          fromPortIdx: templateConn.fromPortIdx,
          toMachineId: idMap.get(templateConn.toMachineId),
          toPortIdx: templateConn.toPortIdx,
        };
      });

      AF.state.currentBlueprintEdit = {
        instanceId: instanceId,
        blueprintId: blueprintId,
        detached: false,
        originalBlueprint: JSON.parse(JSON.stringify(blueprint)),
        childIdMap: idMap
      };
    }

    AF.state.build.placedMachines = machines;
    AF.state.build.connections = connections;
    AF.state.build.selectedMachines = [];
    AF.state.build.camera = { x: 0, y: 0, zoom: 1.0 };

    // Update canvas subtitle to show we're editing
    AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true });
    updateBlueprintEditUI();

    setStatus(`Editing ${detached ? 'detached ' : ''}blueprint: ${blueprintName}`);
  }

  async function exitBlueprintEditMode(skipSave = false) {
    if (AF.state.blueprintEditStack.length === 0) {
      setStatus("Not currently editing a blueprint.", "warning");
      return;
    }

    if (!skipSave && (AF.state.build.placedMachines.length > 0 || AF.state.build.connections.length > 0)) {
      const ok = await AF.ui.dialog.confirm("Exit without saving changes?", { title: "Exit blueprint edit", danger: true });
      if (!ok) return;
    }

    // Pop canvas state from stack
    const previousState = AF.state.blueprintEditStack.pop();
    AF.state.build.placedMachines = previousState.placedMachines;
    AF.state.build.connections = previousState.connections;
    AF.state.build.camera = previousState.camera;
    AF.state.build.selectedMachines = previousState.selectedMachines;

    // Restore previous edit context (if we're still in nested editing)
    AF.state.currentBlueprintEdit = previousState.editContext;

    // Persist the restored state
    // If we're back to main canvas, this saves it to localStorage
    // If we're still nested, saveBuild() will save the main canvas from stack bottom
    AF.core.saveBuild();

    AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true });
    updateBlueprintEditUI();
    setStatus("Exited blueprint edit mode.");
  }

  /**
   * Save blueprint edits to instance only (detaches from source blueprint)
   */
  async function saveBlueprintToInstanceOnly() {
    if (!AF.state.currentBlueprintEdit) {
      setStatus("Not currently editing a blueprint.", "error");
      return;
    }

    const { instanceId } = AF.state.currentBlueprintEdit;

    // Get the parent canvas state (where the instance lives)
    const parentState = AF.state.blueprintEditStack[AF.state.blueprintEditStack.length - 1];
    if (!parentState) {
      setStatus("Parent canvas state not found.", "error");
      return;
    }

    const instance = parentState.placedMachines.find(pm => pm.id === instanceId);
    if (!instance) {
      setStatus("Blueprint instance not found.", "error");
      return;
    }

    // Generate blueprint machine IDs for the machines
    const idToBlueprintId = new Map();
    const firstMachine = AF.state.build.placedMachines[0];
    const originX = firstMachine?.x || 0;
    const originY = firstMachine?.y || 0;

    const childMachines = AF.state.build.placedMachines.map((pm, idx) => {
      const copy = JSON.parse(JSON.stringify(pm));
      copy.x = pm.x - originX; // Store relative positions
      copy.y = pm.y - originY;
      const blueprintMachineId = `bpm_${idx}`;
      copy.blueprintMachineId = blueprintMachineId;
      idToBlueprintId.set(pm.id, blueprintMachineId);

      // Re-add child machine flags
      const childId = `${instanceId}__${blueprintMachineId}`;
      copy.id = childId;
      copy._parentBlueprintId = instanceId;
      copy._isChildMachine = true;

      return copy;
    });

    const childConnections = AF.state.build.connections.map(conn => {
      return {
        id: `${instanceId}__${makeId("conn")}`,
        fromMachineId: `${instanceId}__${idToBlueprintId.get(conn.fromMachineId)}`,
        toMachineId: `${instanceId}__${idToBlueprintId.get(conn.toMachineId)}`,
        fromPortIdx: conn.fromPortIdx,
        toPortIdx: conn.toPortIdx,
        _parentBlueprintId: instanceId
      };
    });

    // Analyze inputs/outputs
    const machineIds = AF.state.build.placedMachines.map(pm => pm.id);
    const analysis = AF.calculator.analyzeBlueprintMachines(machineIds);

    // Create child ID map for port mappings
    const childIdMap = new Map();
    childMachines.forEach(child => {
      childIdMap.set(child.blueprintMachineId, child.id);
    });

    // Rebuild fake blueprint for port mapping
    const fakeBlueprint = {
      machines: childMachines.map(cm => ({
        ...cm,
        blueprintMachineId: cm.blueprintMachineId
      })),
      connections: AF.state.build.connections.map(conn => ({
        fromMachineId: idToBlueprintId.get(conn.fromMachineId),
        toMachineId: idToBlueprintId.get(conn.toMachineId),
        fromPortIdx: conn.fromPortIdx,
        toPortIdx: conn.toPortIdx
      })),
      inputs: analysis.inputs,
      outputs: analysis.outputs
    };

    const portMappings = buildBlueprintPortMappings(fakeBlueprint, instanceId, childIdMap);

    // Update instance
    instance.childMachines = childMachines;
    instance.childConnections = childConnections;
    instance.portMappings = portMappings;
    instance.detached = true;
    instance.blueprintId = null; // No longer linked
    instance.name = instance.name || "Detached Blueprint";

    await exitBlueprintEditMode(true);
    AF.core.saveBuild();
    setStatus(`Blueprint instance updated (detached from source).`);
  }

  async function saveBlueprintEdit() {
    if (!AF.state.currentBlueprintEdit) {
      setStatus("Not currently editing a blueprint.", "error");
      return;
    }

    if (AF.state.currentBlueprintEdit.forceSaveAsNew) {
      await saveBlueprintAsNew();
      return;
    }

    const { blueprintId, instanceId, originalBlueprint, detached } = AF.state.currentBlueprintEdit;

    // If detached, can't save to blueprint definition
    if (detached) {
      const ok = await AF.ui.dialog.confirm(
        "This instance is detached from the source blueprint. Save to instance only?",
        { title: "Detached instance", okText: "Save to instance" }
      );
      if (!ok) return;
      await saveBlueprintToInstanceOnly();
      return;
    }

    const blueprint = AF.state.db.blueprints.find(bp => bp.id === blueprintId);
    if (!blueprint) {
      setStatus("Blueprint not found.", "error");
      return;
    }

    // Analyze current canvas to get new inputs/outputs
    const machineIds = AF.state.build.placedMachines.map(pm => pm.id);
    const analysis = AF.calculator.analyzeBlueprintMachines(machineIds);

    // Check if inputs/outputs have changed
    const inputsChanged = !portsMatch(originalBlueprint.inputs, analysis.inputs);
    const outputsChanged = !portsMatch(originalBlueprint.outputs, analysis.outputs);

    if (inputsChanged || outputsChanged) {
      const msg = "Blueprint inputs/outputs have changed. This will disconnect existing connections to this blueprint instance" +
        (countBlueprintInstances(blueprintId) > 1 ? " (and potentially other instances)" : "") +
        ". Continue?";
      const ok = await AF.ui.dialog.confirm(msg, { title: "Ports changed", danger: true });
      if (!ok) return;
    }

    // Update blueprint definition with properly mapped machines and connections
    // Calculate relative positions from first machine
    const firstMachine = AF.state.build.placedMachines[0];
    const originX = firstMachine?.x || 0;
    const originY = firstMachine?.y || 0;

    // Create a mapping from current IDs to blueprint template IDs
    const idToBlueprintId = new Map();

    const machines = AF.state.build.placedMachines.map((pm, idx) => {
      // Deep copy machine data
      const copy = JSON.parse(JSON.stringify(pm));
      // Store relative position from first machine
      copy.x = pm.x - originX;
      copy.y = pm.y - originY;
      // Use a sequential ID for blueprint template
      const blueprintId = `bpm_${idx}`;
      idToBlueprintId.set(pm.id, blueprintId);
      copy.blueprintMachineId = blueprintId;
      delete copy.id; // Will be assigned when placed
      return copy;
    });

    // Deep copy connections with mapped IDs
    const connections = AF.state.build.connections.map(conn => {
      return {
        fromMachineId: idToBlueprintId.get(conn.fromMachineId),
        fromPortIdx: conn.fromPortIdx,
        toMachineId: idToBlueprintId.get(conn.toMachineId),
        toPortIdx: conn.toPortIdx,
      };
    });

    blueprint.machines = machines;
    blueprint.connections = connections;
    blueprint.inputs = analysis.inputs;
    blueprint.outputs = analysis.outputs;

    // Invalidate cache since blueprint was modified
    AF.calculator?.invalidateBlueprintCountCache?.(blueprintId);

    AF.core.saveDb();

    // Update all instances of this blueprint on parent canvas
    const parentState = AF.state.blueprintEditStack[state.blueprintEditStack.length - 1];
    if (parentState) {
      parentState.placedMachines.forEach(pm => {
        // Update both old and new blueprint types
        if ((pm.type === "blueprint" || pm.type === "blueprint_instance") &&
          pm.blueprintId === blueprintId &&
          !pm.detached) {

          // Update old model data
          pm.blueprintData = {
            name: blueprint.name,
            description: blueprint.description,
            inputs: blueprint.inputs,
            outputs: blueprint.outputs,
            machines: blueprint.machines,
            connections: blueprint.connections,
          };

          // Update new physical model (if it exists)
          if (pm.type === "blueprint_instance" && pm.childMachines) {
            // Refresh child machines from updated blueprint
            refreshBlueprintInstanceFromDefinition(pm, blueprint);
          }

          // If inputs/outputs changed, remove connections that are now invalid
          if (inputsChanged || outputsChanged) {
            removeInvalidConnectionsForBlueprint(parentState.connections, pm.id, blueprint.inputs, blueprint.outputs);
          }
        }
      });
    }

    exitBlueprintEditMode(true);
    AF.core.saveBuild();
    setStatus(`Blueprint "${blueprint.name}" updated (all non-detached instances refreshed).`);
  }

  /**
   * Refresh a blueprint instance's child machines from its blueprint definition
   */
  function refreshBlueprintInstanceFromDefinition(instance, blueprint) {
    const instanceId = instance.id;
    const childIdMap = new Map();

    // Copy machines as physical children
    instance.childMachines = blueprint.machines.map(templateMachine => {
      const childId = `${instanceId}__${templateMachine.blueprintMachineId}`;
      childIdMap.set(templateMachine.blueprintMachineId, childId);

      return {
        ...JSON.parse(JSON.stringify(templateMachine)),
        id: childId,
        _parentBlueprintId: instanceId,
        _isChildMachine: true,
        efficiency: 1.0
      };
    });

    // Copy connections
    instance.childConnections = (blueprint.connections || []).map(templateConn => {
      return {
        id: `${instanceId}__${makeId("conn")}`,
        fromMachineId: childIdMap.get(templateConn.fromMachineId),
        toMachineId: childIdMap.get(templateConn.toMachineId),
        fromPortIdx: templateConn.fromPortIdx,
        toPortIdx: templateConn.toPortIdx,
        _parentBlueprintId: instanceId
      };
    });

    // Rebuild port mappings
    instance.portMappings = buildBlueprintPortMappings(blueprint, instanceId, childIdMap);
    instance.name = blueprint.name;
    instance.description = blueprint.description;
  }

  async function saveBlueprintAsNew() {
    if (!AF.state.currentBlueprintEdit) {
      setStatus("Not currently editing a blueprint.", "error");
      return;
    }

    const originalBlueprint = AF.state.db.blueprints.find(bp => bp.id === AF.state.currentBlueprintEdit.blueprintId);
    if (!originalBlueprint) return;

    const newName = await AF.ui.dialog.prompt(
      "Enter name for new blueprint:",
      originalBlueprint.name + " (Copy)",
      { title: "Save as new blueprint" }
    );
    if (!newName) return;

    // Analyze current canvas
    const machineIds = AF.state.build.placedMachines.map(pm => pm.id);
    const analysis = AF.calculator.analyzeBlueprintMachines(machineIds);

    // Calculate relative positions from first machine
    const firstMachine = AF.state.build.placedMachines[0];
    const originX = firstMachine?.x || 0;
    const originY = firstMachine?.y || 0;

    // Create a mapping from current IDs to blueprint template IDs
    const idToBlueprintId = new Map();

    const machines = AF.state.build.placedMachines.map((pm, idx) => {
      // Deep copy machine data
      const copy = JSON.parse(JSON.stringify(pm));
      // Store relative position from first machine
      copy.x = pm.x - originX;
      copy.y = pm.y - originY;
      // Use a sequential ID for blueprint template
      const blueprintId = `bpm_${idx}`;
      idToBlueprintId.set(pm.id, blueprintId);
      copy.blueprintMachineId = blueprintId;
      delete copy.id; // Will be assigned when placed
      return copy;
    });

    // Deep copy connections with mapped IDs
    const connections = AF.state.build.connections.map(conn => {
      return {
        fromMachineId: idToBlueprintId.get(conn.fromMachineId),
        fromPortIdx: conn.fromPortIdx,
        toMachineId: idToBlueprintId.get(conn.toMachineId),
        toPortIdx: conn.toPortIdx,
      };
    });

    // Create new blueprint
    const newBlueprint = {
      id: makeId("bp"),
      name: newName.trim(),
      description: originalBlueprint.description,
      machines,
      connections,
      inputs: analysis.inputs,
      outputs: analysis.outputs,
    };

    AF.state.db.blueprints.push(newBlueprint);

    // Invalidate cache since we added a new blueprint
    AF.calculator?.invalidateBlueprintCountCache?.(newBlueprint.id);

    AF.core.saveDb();
    AF.render?.renderBlueprintsList?.();

    // Ask if user wants to update the edited instance to use the new blueprint (only if editing an instance)
    if (AF.state.currentBlueprintEdit.instanceId) {
      if (await AF.ui.dialog.confirm(`Update the edited instance to use the new blueprint "${newName}"?`, { title: "Update instance" })) {
        const parentState = AF.state.blueprintEditStack[state.blueprintEditStack.length - 1];
        if (parentState) {
          const instance = parentState.placedMachines.find(pm => pm.id === AF.state.currentBlueprintEdit.instanceId);
          if (instance) {
            instance.blueprintId = newBlueprint.id;
            instance.blueprintData = {
              name: newBlueprint.name,
              description: newBlueprint.description,
              inputs: newBlueprint.inputs,
              outputs: newBlueprint.outputs,
              machines: newBlueprint.machines,
              connections: newBlueprint.connections,
            };
          }
        }
      }
    }

    await exitBlueprintEditMode(true);
    AF.core.saveBuild();
    setStatus(`New blueprint "${newName}" created.`);
  }

  function updateBlueprintEditUI() {
    // Delegated to render layer (moved to render.app.js)
    AF.render?.updateBlueprintEditUI?.();
  }


  function portsMatch(portsA, portsB) {
    if (portsA.length !== portsB.length) return false;

    // Create maps of materialId -> rate
    const mapA = new Map(portsA.map(p => [p.materialId, p.rate]));
    const mapB = new Map(portsB.map(p => [p.materialId, p.rate]));

    for (const [matId, rate] of mapA) {
      if (!mapB.has(matId) || Math.abs(mapB.get(matId) - rate) > 0.01) {
        return false;
      }
    }

    return true;
  }

  function countBlueprintInstances(blueprintId) {
    return AF.state.build.placedMachines.filter(pm =>
      (pm.type === "blueprint" || pm.type === "blueprint_instance") && pm.blueprintId === blueprintId
    ).length;
  }

  function removeInvalidConnectionsForBlueprint(connections, blueprintInstanceId, newInputs, newOutputs) {
    // Remove connections to input ports that no longer exist
    const validInputMaterials = new Set(newInputs.map(inp => inp.materialId));
    const validOutputMaterials = new Set(newOutputs.map(out => out.materialId));

    const toRemove = [];

    connections.forEach((conn, idx) => {
      // Check connections TO this blueprint (inputs)
      if (conn.toMachineId === blueprintInstanceId) {
        const sourceMachine = AF.state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
        if (sourceMachine) {
          const materialId = AF.core.getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
          if (!validInputMaterials.has(materialId)) {
            toRemove.push(idx);
          }
        }
      }

      // Check connections FROM this blueprint (outputs)
      if (conn.fromMachineId === blueprintInstanceId) {
        const blueprintMachine = AF.state.build.placedMachines.find(pm => pm.id === blueprintInstanceId);
        if (blueprintMachine) {
          const materialId = AF.core.getMaterialIdFromPort(blueprintMachine, conn.fromPortIdx, "output");
          if (!validOutputMaterials.has(materialId)) {
            toRemove.push(idx);
          }
        }
      }
    });

    // Remove invalid connections (in reverse order to maintain indices)
    for (let i = toRemove.length - 1; i >= 0; i--) {
      connections.splice(toRemove[i], 1);
    }
  }


  function saveManualStorageMaterial() {
    const form = $("#manualStorageForm");
    if (!form) return;

    const machineId = AF.state.ui.pendingManualStorageMachineId;
    if (!machineId) return;

    const placedMachine = AF.state.build.placedMachines.find(pm => pm.id === machineId);
    if (!placedMachine) return;

    const formData = new FormData(form);
    const materialId = formData.get("materialId");
    const slotsAllocated = parseInt(formData.get("slotsAllocated")) || 1;
    const currentAmount = parseInt(formData.get("currentAmount")) || 0;

    if (!materialId) {
      setStatus("Please select a material.", "error");
      return;
    }

    // Initialize manualInventories if needed
    if (!placedMachine.manualInventories) {
      placedMachine.manualInventories = [];
    }

    // Add the material
    placedMachine.manualInventories.push({
      materialId,
      slotsAllocated,
      currentAmount
    });

    AF.core.saveBuild();
    AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreation since storage content changed
    closeDialog();
    AF.state.ui.pendingManualStorageMachineId = null;
    setStatus("Material added to storage.");
  }

  function removeManualStorageMaterial(machineId, idx) {
    const placedMachine = AF.state.build.placedMachines.find(pm => pm.id === machineId);
    if (!placedMachine || !placedMachine.manualInventories) return;

    placedMachine.manualInventories.splice(idx, 1);

    AF.core.saveBuild();
    AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreation since storage content changed
    setStatus("Material removed from storage.");
  }


  // ---------- Heating Device Topper Management ----------

  function openAddTopperDialog(heatingDeviceId) {
    const placedMachine = AF.state.build.placedMachines.find(pm => pm.id === heatingDeviceId);
    if (!placedMachine) return;

    const machine = AF.core.getMachineById(placedMachine.machineId);
    if (!machine || machine.kind !== "heating_device") return;

    // Get available topper machines (requiresFurnace = true)
    const topperMachines = AF.state.db.machines.filter(m => m.requiresFurnace);

    if (topperMachines.length === 0) {
      setStatus("No topper machines configured.", "error");
      return;
    }

    // Store the heating device ID
    AF.state.ui.pendingHeatingDeviceId = heatingDeviceId;

    // Populate topper machines dropdown
    const form = $("#addTopperForm");
    if (!form) return;

    const machineSelect = form.querySelector('[name="topperMachineId"]');
    const countInput = form.querySelector('[name="topperCount"]');
    if (machineSelect) {
      machineSelect.innerHTML = '<option value="">(select topper machine)</option>' +
        topperMachines.map(m =>
          `<option value="${m.id}">${escapeHtml(m.name)} (${m.footprintWidth || 1}x${m.footprintLength || 1} tiles, ${m.heatConsumptionP || 0}P)</option>`
        ).join("");

      // Reset fields
      machineSelect.value = "";

      // Update recipe + quantity constraints when machine changes
      machineSelect.onchange = () => {
        updateTopperRecipeOptions();
        updateTopperQuantityLimits();
      };
    }

    if (countInput) {
      countInput.value = "1";
      countInput.setAttribute("min", "1");
      countInput.setAttribute("step", "1");
      countInput.disabled = true; // enabled when a topper machine is chosen
      countInput.oninput = () => {
        // Clamp live while user types
        updateTopperQuantityLimits(true);
      };
    }

    // Show dialog
    const dialog = $("#addTopperDialog");
    if (dialog) {
      // Title: "Add Device to <parent machine name>"
      const title = dialog.querySelector(".dialog__title");
      if (title) title.textContent = `Add Device to ${machine.name}`;
      dialog.classList.remove("hidden");
    }

    // Ensure the initial max is correct (no selection yet)
    updateTopperRecipeOptions();
    updateTopperQuantityLimits();
  }

  /**
   * Updates the quantity field max based on remaining heating area capacity.
   * @param {boolean=} clampOnly If true, only clamps current value (no disabling/enabling logic)
   */
  function updateTopperQuantityLimits(clampOnly = false) {
    const form = $("#addTopperForm");
    if (!form) return;

    const heatingDeviceId = AF.state.ui.pendingHeatingDeviceId;
    if (!heatingDeviceId) return;

    const placedMachine = AF.state.build.placedMachines.find(pm => pm.id === heatingDeviceId);
    if (!placedMachine) return;

    const heatingDef = placedMachine.machineId ? AF.core.getMachineById(placedMachine.machineId) : null;
    if (!heatingDef || heatingDef.kind !== "heating_device") return;

    const machineSelect = form.querySelector('[name="topperMachineId"]');
    const countInput = form.querySelector('[name="topperCount"]');
    if (!machineSelect || !countInput) return;

    const selectedMachineId = machineSelect.value;
    if (!selectedMachineId) {
      if (!clampOnly) {
        countInput.value = "1";
        countInput.disabled = true;
        countInput.removeAttribute("max");
      }
      return;
    }

    const topperMachine = AF.core.getMachineById(selectedMachineId);
    if (!topperMachine) return;

    const totalArea = (heatingDef.heatingAreaWidth || 1) * (heatingDef.heatingAreaLength || 1);
    let usedArea = 0;
    (placedMachine.toppers || []).forEach(t => {
      const tm = AF.core.getMachineById(t.machineId);
      if (tm) usedArea += ((tm.footprintWidth || 1) * (tm.footprintLength || 1));
    });

    const footprintArea = (topperMachine.footprintWidth || 1) * (topperMachine.footprintLength || 1);
    const remainingArea = Math.max(0, totalArea - usedArea);
    const maxQty = footprintArea > 0 ? Math.max(0, Math.floor(remainingArea / footprintArea)) : 0;

    if (!clampOnly) {
      countInput.disabled = maxQty <= 0;
      countInput.setAttribute("max", String(Math.max(1, maxQty)));
    }

    // Clamp current value
    const current = parseInt(String(countInput.value || "1"), 10);
    const clamped = Math.max(1, Math.min(Number.isFinite(current) ? current : 1, Math.max(1, maxQty)));
    countInput.value = String(clamped);
  }

  function updateTopperRecipeOptions() {
    const form = $("#addTopperForm");
    if (!form) return;

    const machineSelect = form.querySelector('[name="topperMachineId"]');
    const recipeSelect = form.querySelector('[name="topperRecipeId"]');
    if (!machineSelect || !recipeSelect) return;

    const selectedMachineId = machineSelect.value;

    if (!selectedMachineId) {
      recipeSelect.innerHTML = '<option value="">(no recipe)</option>';
      return;
    }

    // Get recipes for this machine
    const recipes = AF.state.db.recipes.filter(r => r.machineId === selectedMachineId);

    recipeSelect.innerHTML = '<option value="">(no recipe)</option>' +
      recipes.map(r =>
        `<option value="${r.id}">${escapeHtml(r.name)}</option>`
      ).join("");
  }

  async function saveTopperFromDialog() {
    const form = $("#addTopperForm");
    if (!form) return;

    const heatingDeviceId = AF.state.ui.pendingHeatingDeviceId;
    if (!heatingDeviceId) return;

    const placedMachine = AF.state.build.placedMachines.find(pm => pm.id === heatingDeviceId);
    if (!placedMachine) return;

    const machine = AF.core.getMachineById(placedMachine.machineId);
    if (!machine || machine.kind !== "heating_device") return;

    const fd = new FormData(form);
    const topperMachineId = fd.get("topperMachineId");
    const topperRecipeId = fd.get("topperRecipeId") || null;
    const topperCountRaw = fd.get("topperCount");

    if (!topperMachineId) {
      setStatus("Please select a topper machine.", "error");
      return;
    }

    const topperMachine = AF.core.getMachineById(topperMachineId);
    if (!topperMachine) {
      setStatus("Invalid topper machine.", "error");
      return;
    }

    // Check if adding this topper would exceed heating area
    const totalArea = (machine.heatingAreaWidth || 1) * (machine.heatingAreaLength || 1);
    const topperFootprint = (topperMachine.footprintWidth || 1) * (topperMachine.footprintLength || 1);

    let usedArea = 0;
    (placedMachine.toppers || []).forEach(t => {
      const tm = AF.core.getMachineById(t.machineId);
      if (tm) {
        usedArea += (tm.footprintWidth || 1) * (tm.footprintLength || 1);
      }
    });

    const remainingArea = Math.max(0, totalArea - usedArea);
    const maxQty = topperFootprint > 0 ? Math.floor(remainingArea / topperFootprint) : 0;
    if (maxQty <= 0) {
      setStatus(`No heating area remaining (used ${usedArea} / ${totalArea} tiles).`, "error");
      return;
    }

    let topperCount = parseInt(String(topperCountRaw ?? "1"), 10);
    if (!Number.isFinite(topperCount) || topperCount < 1) topperCount = 1;
    if (topperCount > maxQty) {
      setStatus(`Quantity exceeds heating area capacity (max ${maxQty}).`, "error");
      // Clamp UI value if present
      const countInput = form.querySelector('[name="topperCount"]');
      if (countInput) countInput.value = String(maxQty);
      return;
    }

    // Initialize toppers array if needed
    if (!placedMachine.toppers) {
      placedMachine.toppers = [];
    }

    // Add the topper N times (equivalent to repeating the dialog)
    for (let i = 0; i < topperCount; i++) {
      placedMachine.toppers.push({
        machineId: topperMachineId,
        recipeId: topperRecipeId,
      });
    }

    // Clear pending state
    AF.state.ui.pendingHeatingDeviceId = null;

    // Close dialog
    closeDialog();

    // Save and re-render
    AF.core.saveBuild();
    AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreation since machine content changed
    setStatus("Topper added to heating device.");
  }

  async function removeTopper(heatingDeviceId, topperIdx) {
    const placedMachine = AF.state.build.placedMachines.find(pm => pm.id === heatingDeviceId);
    if (!placedMachine || !placedMachine.toppers) return;

    const ok = await AF.ui.dialog.confirm("Remove this topper from the heating device?", { title: "Remove topper", danger: true });
    if (!ok) return;

    const topper = placedMachine.toppers[topperIdx];
    const topperRecipe = topper?.recipeId ? AF.core.getRecipeById(topper.recipeId) : null;

    // Collect materials used by this topper
    const inputMaterials = new Set();
    const outputMaterials = new Set();

    if (topperRecipe) {
      topperRecipe.inputs.forEach(inp => {
        if (inp.materialId) inputMaterials.add(inp.materialId);
      });
      topperRecipe.outputs.forEach(out => {
        if (out.materialId) outputMaterials.add(out.materialId);
      });
    }

    // Remove the topper
    placedMachine.toppers.splice(topperIdx, 1);

    // Check which materials are still produced/consumed by remaining toppers
    const remainingInputMaterials = new Set();
    const remainingOutputMaterials = new Set();

    placedMachine.toppers.forEach(t => {
      const recipe = t.recipeId ? AF.core.getRecipeById(t.recipeId) : null;
      if (recipe) {
        recipe.inputs.forEach(inp => {
          if (inp.materialId) remainingInputMaterials.add(inp.materialId);
        });
        recipe.outputs.forEach(out => {
          if (out.materialId) remainingOutputMaterials.add(out.materialId);
        });
      }
    });

    // Remove connections to grouped ports for materials no longer produced/consumed
    AF.state.build.connections = AF.state.build.connections.filter(conn => {
      // Check input connections
      if (conn.toMachineId === heatingDeviceId && typeof conn.toPortIdx === 'string') {
        if (conn.toPortIdx.startsWith('grouped-input-')) {
          const materialId = conn.toPortIdx.replace(/^grouped-input-/, '');
          if (inputMaterials.has(materialId) && !remainingInputMaterials.has(materialId)) {
            return false; // Remove this connection
          }
        }
      }

      // Check output connections
      if (conn.fromMachineId === heatingDeviceId && typeof conn.fromPortIdx === 'string') {
        if (conn.fromPortIdx.startsWith('grouped-output-')) {
          const materialId = conn.fromPortIdx.replace(/^grouped-output-/, '');
          if (outputMaterials.has(materialId) && !remainingOutputMaterials.has(materialId)) {
            return false; // Remove this connection
          }
        }
      }

      return true;
    });

    AF.core.saveBuild();
    AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreation since machine content changed
    setStatus("Topper removed from heating device.");
  }

  function updateTopperRecipe(heatingDeviceId, topperIdx, recipeId) {
    const placedMachine = AF.state.build.placedMachines.find(pm => pm.id === heatingDeviceId);
    if (!placedMachine || !placedMachine.toppers || !placedMachine.toppers[topperIdx]) return;

    const oldRecipe = placedMachine.toppers[topperIdx].recipeId ? AF.core.getRecipeById(placedMachine.toppers[topperIdx].recipeId) : null;

    // Collect materials from old recipe
    const oldInputMaterials = new Set();
    const oldOutputMaterials = new Set();

    if (oldRecipe) {
      oldRecipe.inputs.forEach(inp => {
        if (inp.materialId) oldInputMaterials.add(inp.materialId);
      });
      oldRecipe.outputs.forEach(out => {
        if (out.materialId) oldOutputMaterials.add(out.materialId);
      });
    }

    // Update the recipe
    placedMachine.toppers[topperIdx].recipeId = recipeId;

    // Collect materials from all toppers after the update
    const allInputMaterials = new Set();
    const allOutputMaterials = new Set();

    placedMachine.toppers.forEach(t => {
      const recipe = t.recipeId ? AF.core.getRecipeById(t.recipeId) : null;
      if (recipe) {
        recipe.inputs.forEach(inp => {
          if (inp.materialId) allInputMaterials.add(inp.materialId);
        });
        recipe.outputs.forEach(out => {
          if (out.materialId) allOutputMaterials.add(out.materialId);
        });
      }
    });

    // Remove connections to grouped ports for materials no longer produced/consumed
    AF.state.build.connections = AF.state.build.connections.filter(conn => {
      // Check input connections
      if (conn.toMachineId === heatingDeviceId && typeof conn.toPortIdx === 'string') {
        if (conn.toPortIdx.startsWith('grouped-input-')) {
          const materialId = conn.toPortIdx.replace(/^grouped-input-/, '');
          if (oldInputMaterials.has(materialId) && !allInputMaterials.has(materialId)) {
            return false; // Remove this connection
          }
        }
      }

      // Check output connections
      if (conn.fromMachineId === heatingDeviceId && typeof conn.fromPortIdx === 'string') {
        if (conn.fromPortIdx.startsWith('grouped-output-')) {
          const materialId = conn.fromPortIdx.replace(/^grouped-output-/, '');
          if (oldOutputMaterials.has(materialId) && !allOutputMaterials.has(materialId)) {
            return false; // Remove this connection
          }
        }
      }

      return true;
    });

    AF.core.saveBuild();
    AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Force recreation since machine content changed
  }

  function renderSkillsList() {
    const list = $("#skillsList");
    if (!list) return;

    const skills = [
      {
        id: "conveyorSpeed",
        name: "Conveyor Speed",
        description: "Each point adds +15/min to conveyor speed (base 60/min)",
        value: AF.state.skills.conveyorSpeed,
      },
      {
        id: "throwingSpeed",
        name: "Throwing Speed",
        description: "Each point adds +15/min to throwing speed (base 60/min)",
        value: AF.state.skills.throwingSpeed,
      },
      {
        id: "machineEfficiency",
        name: "Machine Efficiency",
        description: "Each point reduces recipe processing time by 25% and increases fuel consumption by 25%",
        value: AF.state.skills.machineEfficiency,
      },
      {
        id: "alchemyEfficiency",
        name: "Alchemy Efficiency",
        description: "Each point adds +3% to Extractor output (extractors convert solid to liquid)",
        value: AF.state.skills.alchemyEfficiency,
      },
      {
        id: "fuelEfficiency",
        name: "Fuel Efficiency",
        description: "Each point adds +10% to fuel consumption rate",
        value: AF.state.skills.fuelEfficiency,
      },
      {
        id: "fertilizerEfficiency",
        name: "Fertilizer Efficiency",
        description: "Each point adds +10% to fertilizer value",
        value: AF.state.skills.fertilizerEfficiency,
      },
      {
        id: "shopProfit",
        name: "Shop Profit",
        description: "Each point adds +3% to shop profit",
        value: AF.state.skills.shopProfit,
      },
    ];

    list.innerHTML = skills.map(skill => `
      <div class="skillItem">
        <div class="skillItem__info">
          <div class="skillItem__name">${escapeHtml(skill.name)}</div>
          <div class="skillItem__description">${escapeHtml(skill.description)}</div>
        </div>
        <input 
          type="number" 
          class="skillItem__input" 
          data-skill="${skill.id}" 
          value="${skill.value}" 
          min="0" 
          max="10"
        />
      </div>
    `).join("");
  }

  function saveSkillsFromDialog() {
    const inputs = $$("[data-skill]");
    inputs.forEach(input => {
      const skillId = input.dataset.skill;
      const value = parseInt(input.value) || 0;
      if (AF.state.skills.hasOwnProperty(skillId)) {
        AF.state.skills[skillId] = Math.max(0, Math.min(10, value));
      }
    });

    AF.core.saveSkills();
    closeDialog();
    renderSkillsBar(); // Update skills bar
    AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true }); // Re-render canvas to apply skill effects
    setStatus("Skills updated.");
  }

  function readIoFromForm(fd, kind) {
    // Extract keys like inputs[0].materialId, inputs[0].items ...
    const rows = [];
    for (const [k, v] of fd.entries()) {
      const m = /^(\w+)\[(\d+)\]\.(\w+)$/.exec(k);
      if (!m) continue;
      const group = m[1];
      if (group !== kind) continue;
      const idx = Number(m[2]);
      const field = m[3];
      if (!Number.isFinite(idx)) continue;
      if (!rows[idx]) rows[idx] = { materialId: "", items: 0 };
      if (field === "materialId") rows[idx].materialId = String(v ?? "");
      if (field === "items") rows[idx].items = toNumberOrNull(v) ?? 0;
    }
    return rows.filter(Boolean);
  }


  Object.assign(AF.ui, {
    init,
    updateLayoutGridColumns,
    updateCreateBlueprintButton,
    updateSelectionClasses,
    showValidationWarning,
    setStatus,
    renderAllUIElements,
    renderProductionSummary
  });

})();

