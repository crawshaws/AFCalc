/// <reference path="shared.app.js" />

/* Alchemy Factory Planner (Offline)
 * - Stores data in localStorage
 * - Import/Export JSON
 * - CRUD Materials, Machines (incl Furnace special case), Recipes
 */

(() => {
  "use strict";

  // Global namespace for layered scripts (classic scripts, file:// safe)

  /** @type {AF} */
  const AF = (window.AF = window.AF || {});

  /*
   * =====================================================================================
   *  NOTE FOR MANUAL SPLIT (requested workflow)
   *
   *  This file is being refactored into 4 logical sections that match:
   *    - calculator.app.js
   *    - render.app.js
   *    - ui.app.js
   *    - app.js (core/orchestrator)
   *
   *  For now, everything stays in this single file to keep the app running.
   *  Once refactor is complete, you can cut/paste each marked section into its target file.
   * =====================================================================================
   */

  const STORAGE_KEY = "af_planner_db_v1";
  const BUILD_STORAGE_KEY = "af_planner_build_v1";
  const SKILLS_STORAGE_KEY = "af_planner_skills_v1";
  const UI_PREFS_STORAGE_KEY = "af_planner_ui_prefs_v1";
  const WORKSPACES_STORAGE_KEY = "af_planner_workspaces_v1";
  const SETTINGS_STORAGE_KEY = "af_planner_settings_v1";
  const SCHEMA_VERSION = 1;

  // Game constants
  const CONVEYOR_SPEED = 60; // items per minute

  /** @type {AppState} */
  const state = {
    db: createEmptyDb(),
    // Derived/calculated snapshot used by render-only code paths.
    // This is not persisted; it is recomputed when build/db/skills change.
    calc: {
      // Filled by AF.calculator.recalculateAll()
      lastCalculatedAt: 0,
      netProduction: null, // { exports: Map, imports: Map }
      sources: null, // Array of placedMachine objects (from tree)
      sinks: null, // Array of placedMachine objects (from tree)
      purchasingCosts: null, // { totalCopper, breakdown: Map }
      importCosts: null, // Map materialId -> { rate, costPerMinute, material, realizedCost }
      totalImportCost: 0,
      totalCost: 0,
      storageFillItems: null, // Array of { storageId, storageName, materialId, materialName, netRate, inputRate, timeToFillMinutes }
    },
    ui: {
      activeTab: "materials",
      selected: {
        materials: null,
        machines: null,
      },
      filters: {
        materials: "",
        machines: "",
      },
      sidebars: {
        database: true,
        blueprints: false,
        production: false,
      },
      statusTimer: null,
      pendingStorageCoords: null,
      pendingManualStorageMachineId: null,
      pendingStorageReplacementId: null,
      pendingHeatingDeviceId: null,
      pendingBlueprintCoords: null,
      dragState: null, // For canvas dragging and connection preview
      justCompletedSelection: false, // Flag to prevent click from clearing selection after drag-select
      productionSummaryDebounceTimer: null, // Debounce timer for production summary recalculation
    },
    build: {
      placedMachines: [], // Array of placed machine instances on canvas
      connections: [], // Array of conveyor connections
      selectedMachines: [], // Array of selected machine IDs (supports multi-select)
      selectedConnection: null, // Currently selected connection on canvas
      camera: { x: 0, y: 0, zoom: 1.0 }, // Camera position (world coords at viewport center) and zoom level
    },
    // Multiple independent production workspaces (tabs).
    // Each tab owns a build/canvas state; switching tabs swaps `state.build`.
    workspaces: {
      version: 1,
      activeId: null,
      /** @type {Array<{ id: string, name: string, build: { placedMachines: Array<any>, connections: Array<any>, camera: any } }>} */
      tabs: [],
    },
    blueprintEditStack: [], // Stack of canvas states when editing blueprints recursively
    currentBlueprintEdit: null, // { blueprintId, instanceId (if editing a placed instance), parentInstanceId (for nested edits) }
    blueprintMachineCountCache: {}, // Cache for recursive blueprint machine counts { blueprintId: { totalCount, breakdown: { machineId: count } } }
    skills: {
      conveyorSpeed: 0, // Each point = +15p/m speed bonus - Base 60p/m
      throwingSpeed: 0, // Each point = +15p/m speed bonus - Base 60p/m
      machineEfficiency: 0, // Each point = 25% reduction in processing time + 25% increase to fuel consumption - Base 100%
      alchemyEfficiency: 0, // Each point = +3% Extractor Output - Base 100% (Extractor is a machine that takes in solid produces liquid)
      fuelEfficiency: 0, // Each point = +10% fuel value of materials (Pyra/P) - Base 100%
      fertilizerEfficiency: 0, // Each point = +10% fertilizer Nutrient Value (V) - Base 100%      
      shopProfit: 0, // Each point = +3% (increasing) shop profit - Base 100%
    },
    settings: {
      version: 1,
      costBlueprints: {
        fuel: { blueprintId: null, outputMaterialId: null },
        fertilizer: { blueprintId: null, outputMaterialId: null },
      },
    },
  };

  // Expose shared state early so other layer files can reference it.
  /** @type {AppState} */
  AF.state = state;
  /** @type {Object} */
  AF.consts = AF.consts || {};
  AF.consts.STORAGE_KEY = STORAGE_KEY;
  AF.consts.BUILD_STORAGE_KEY = BUILD_STORAGE_KEY;
  AF.consts.SKILLS_STORAGE_KEY = SKILLS_STORAGE_KEY;
  AF.consts.UI_PREFS_STORAGE_KEY = UI_PREFS_STORAGE_KEY;
  AF.consts.WORKSPACES_STORAGE_KEY = WORKSPACES_STORAGE_KEY;
  AF.consts.SETTINGS_STORAGE_KEY = SETTINGS_STORAGE_KEY;
  AF.consts.SCHEMA_VERSION = SCHEMA_VERSION;
  AF.consts.CONVEYOR_SPEED = CONVEYOR_SPEED;




  

  // Core shared utilities (used by ui/render/calculator layers)
  AF.core = AF.core || {};
  Object.assign(AF.core, {
    $,
    $$
  });







  // ---------- DB ----------

  function createEmptyDb() {
    const now = new Date().toISOString();
    return {
      version: SCHEMA_VERSION,
      meta: {
        createdAt: now,
        updatedAt: now,
      },
      materials: [],
      machines: [],
      recipes: [],
      blueprints: [],
    };
  }

  function touchUpdatedAt() {
    state.db.meta.updatedAt = new Date().toISOString();
  }

  function saveDb() {
    touchUpdatedAt();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.db, null, 2));
  }

  function loadDb() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyDb();
    try {
      const parsed = JSON.parse(raw);
      const normalized = normalizeDb(parsed);
      return normalized;
    } catch {
      return createEmptyDb();
    }
  }

  function clearDb() {
    state.db = createEmptyDb();
    saveDb();
    state.ui.selected.materials = null;
    state.ui.selected.machines = null;
    AF.ui.renderAllUIElements();
    AF.ui.setStatus("Cleared local database.", "info");
  }

  function exportDb() {
    const content = JSON.stringify(state.db, null, 2);
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `alchemy-factory-db-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    AF.ui.setStatus("Exported database JSON.");
  }

  /**
   * Export entire state (database + build + skills)
   */
  function exportFullState() {
    const activeWorkspace = getActiveWorkspaceTab();
    const fullState = {
      version: 1,
      database: state.db,
      build: {
        placedMachines: state.build.placedMachines,
        connections: state.build.connections,
        camera: state.build.camera
      },
      workspace: activeWorkspace ? { id: activeWorkspace.id, name: activeWorkspace.name } : null,
      skills: state.skills
    };

    const content = JSON.stringify(fullState, null, 2);
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `alchemy-factory-full-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    AF.ui.setStatus("Exported full state (database + build + skills).");
  }

  /**
   * Export build only (canvas state) for sharing/debugging.
   * This is intentionally compact and importable.
   */
  function exportBuildState() {
    const activeWorkspace = getActiveWorkspaceTab();
    const workspaceName = activeWorkspace?.name || null;
    const buildState = {
      version: 1,
      kind: "af_build_v1",
      name: workspaceName,
      build: {
        placedMachines: state.build.placedMachines,
        connections: state.build.connections,
        camera: state.build.camera,
      },
    };

    const safeName = workspaceName
      ? String(workspaceName).trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "").replace(/\s+/g, "-").slice(0, 60)
      : "";
    const content = JSON.stringify(buildState, null, 2);
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `alchemy-factory-build${safeName ? `-${safeName}` : ""}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    AF.ui.setStatus("Exported build (canvas only).");
  }

     
  /**
   * Import full state with validation
   * @param {File} file
   * @returns {Promise<void>}
   */
  async function importFullState(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    
    // Check if this is a full state export or just database
    if (parsed.version && parsed.database && parsed.build) {
      // Full state import
      state.db = normalizeDb(parsed.database);
      AF.core.saveDb();
      
      // Validate build before importing
      const placedMachines = Array.isArray(parsed.build.placedMachines) ? parsed.build.placedMachines : [];
      const connections = Array.isArray(parsed.build.connections) ? parsed.build.connections : [];

      state.build.placedMachines = placedMachines;
      state.build.connections = connections;
      state.build.selectedMachines = [];
      
      // Import camera if present, otherwise use defaults
      if (parsed.build.camera && typeof parsed.build.camera === 'object') {
        state.build.camera = {
          x: Number(parsed.build.camera.x) || 0,
          y: Number(parsed.build.camera.y) || 0,
          zoom: Number(parsed.build.camera.zoom) || 1.0
        };
      } else {
        state.build.camera = { x: 0, y: 0, zoom: 1.0 };
      }
      
      saveBuild();
      
      // Import skills if present
      if (parsed.skills) {
        state.skills = parsed.skills;
        saveSkills();
      }
      
      state.ui.selected.materials = null;
      state.ui.selected.machines = null;
      AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true });
      AF.ui.setStatus("Imported full state with validation.", "ok");
    } else {
      // Legacy database-only import
      state.db = normalizeDb(parsed);
      saveDb();
      state.ui.selected.materials = null;
      state.ui.selected.machines = null;
      AF.scheduler.invalidate({ needsRecalc: true, needsRender: true, forceRecreate: true });
      AF.ui.setStatus("Imported database JSON.", "ok");
    }

    return validateBuild(placedMachines, connections);
  }

  /**
   * Import build (canvas) only.
   * - Accepts `af_build_v1` exports (from Export Build)
   * - Also accepts full-state exports, but only applies the build portion
   * - Keeps the current database/skills intact
   * - Ensures any blueprint definitions referenced by placed blueprint instances exist in `state.db.blueprints`
   * @param {File} file
   * @returns {Promise<void>}
   */
  async function importBuildState(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);

    /** @type {{ placedMachines: Array<any>, connections: Array<any>, camera?: any } | null} */
    let build = null;
    /** @type {string|null} */
    let name = null;

    if (parsed && parsed.kind === "af_build_v1" && parsed.build) {
      build = parsed.build;
      name = typeof parsed.name === "string" ? parsed.name : null;
    } else if (parsed && parsed.version && parsed.build) {
      // Full-state style export; take the build portion only.
      build = parsed.build;
      name = typeof parsed?.workspace?.name === "string" ? parsed.workspace.name : null;
    } else if (parsed && Array.isArray(parsed.placedMachines) && Array.isArray(parsed.connections)) {
      // Loose build object (localStorage-like)
      build = parsed;
      name = typeof parsed.name === "string" ? parsed.name : null;
    }

    if (!build) throw new Error("Unrecognized build JSON format");

    const normalizedBuild = normalizeBuildData(build);
    const placedMachines = normalizedBuild.placedMachines;
    const connections = normalizedBuild.connections;

    // Ensure blueprints referenced by blueprint instances exist in the DB.
    // This is required for blueprint sidebar visibility and blueprint editing.
    ensureBlueprintsInDbFromBuild(placedMachines);

    const tabName = (typeof name === "string" && name.trim()) ? name.trim() : getNextDefaultWorkspaceName();
    const newTab = createWorkspaceTab({ name: tabName, build: normalizedBuild, switchTo: true });
    if (newTab) {
      AF.ui?.setStatus?.(`Loaded build into new tab: "${newTab.name}".`, "ok");
    } else {
      AF.ui?.setStatus?.("Loaded build JSON.", "ok");
    }
  }

  /**
   * Ensures blueprints referenced by placed blueprint instances exist in the DB.
   * @param {Array<any>} placedMachines
   */
  function ensureBlueprintsInDbFromBuild(placedMachines) {
    if (!Array.isArray(state.db.blueprints)) state.db.blueprints = [];

    const existingIds = new Set((state.db.blueprints || []).map(bp => bp?.id).filter(Boolean));
    let added = 0;

    const queue = Array.isArray(placedMachines) ? [...placedMachines] : [];
    while (queue.length) {
      const pm = queue.shift();
      if (!pm || typeof pm !== "object") continue;

      if ((pm.type === "blueprint_instance" || pm.type === "blueprint") && Array.isArray(pm.childMachines)) {
        pm.childMachines.forEach(cm => queue.push(cm));
      }

      if (!(pm.type === "blueprint_instance" || pm.type === "blueprint")) continue;
      const blueprintId = pm.blueprintId;
      const bpData = pm.blueprintData;
      if (!blueprintId || !bpData) continue;
      if (existingIds.has(blueprintId)) continue;

      // Minimal blueprint template record (same shape as created blueprints)
      state.db.blueprints.push({
        id: blueprintId,
        name: bpData.name || pm.name || "Imported Blueprint",
        description: bpData.description || "",
        machines: Array.isArray(bpData.machines) ? bpData.machines : [],
        connections: Array.isArray(bpData.connections) ? bpData.connections : [],
        inputs: Array.isArray(bpData.inputs) ? bpData.inputs : [],
        outputs: Array.isArray(bpData.outputs) ? bpData.outputs : [],
        createdAt: bpData.createdAt || new Date().toISOString(),
      });

      existingIds.add(blueprintId);
      added++;
    }

    if (added > 0) saveDb();
  }

  /**
   * Save the build to localStorage
   * IMPORTANT: Blueprint editing is an in-memory operation only.
   * When in blueprint edit mode, this saves the MAIN canvas (from the bottom of the edit stack),
   * NOT the current blueprint being edited. This ensures that refreshing the page always
   * loads the main canvas, and edits are only persisted when explicitly saved via
   * saveBlueprintEdit() or saveBlueprintAsNew().
   */
  function saveBuild() {
    let buildData;

    if (state.blueprintEditStack.length > 0) {
      // We're in blueprint edit mode - save the main canvas (bottom of stack)
      const mainCanvasState = state.blueprintEditStack[0];
      buildData = {
        placedMachines: mainCanvasState.placedMachines,
        connections: mainCanvasState.connections,
        camera: mainCanvasState.camera,
      };
    } else {
      // Normal mode - save current canvas
      buildData = {
        placedMachines: state.build.placedMachines,
        connections: state.build.connections,
        camera: state.build.camera,
      };
    }

    // Persist to the active workspace tab (primary storage).
    const tab = getActiveWorkspaceTab();
    if (tab) {
      tab.build = buildData;
      saveWorkspaces();
    }

    // Backward compatibility: mirror active workspace to legacy build key.
    localStorage.setItem(BUILD_STORAGE_KEY, JSON.stringify(buildData, null, 2));
  }

  /**
   * Validate a build's connections against its placed machines
   * Returns list of validation issues
   * @param {Array<PlacedMachine>} placedMachines
   * @param {Array<Connection>} connections
   * @returns {Array<ValidationIssue>}
   */
  function validateBuild(placedMachines, connections) {
    const issues = [];
    const machineIds = new Set(placedMachines.map(pm => pm.id));

    connections.forEach((conn, idx) => {
      // Check if machines exist
      if (!machineIds.has(conn.fromMachineId)) {
        issues.push({
          type: 'missing-source',
          connection: idx,
          machineId: conn.fromMachineId,
          message: `Connection #${idx + 1}: Source machine no longer exists`
        });
        return;
      }

      if (!machineIds.has(conn.toMachineId)) {
        issues.push({
          type: 'missing-target',
          connection: idx,
          machineId: conn.toMachineId,
          message: `Connection #${idx + 1}: Target machine no longer exists`
        });
        return;
      }

      // Validate source port exists
      const sourceMachine = placedMachines.find(pm => pm.id === conn.fromMachineId);
      if (sourceMachine) {
        const sourceMachineDef = getMachineById(sourceMachine.machineId);
        if (sourceMachineDef) {
          // Check if it's a heating device with grouped ports
          if (sourceMachineDef.kind === "heating_device" && typeof conn.fromPortIdx === 'string') {
            if (conn.fromPortIdx.startsWith('grouped-output-')) {
              // Validate the material exists
              const materialId = conn.fromPortIdx.replace(/^grouped-output-/, '');
              if (!getMaterialById(materialId)) {
                issues.push({
                  type: 'invalid-port',
                  connection: idx,
                  message: `Connection #${idx + 1}: Output port references non-existent material`
                });
              }
            } else if (conn.fromPortIdx.startsWith('topper-')) {
              // Old topper port format - flag as outdated
              issues.push({
                type: 'outdated-port',
                connection: idx,
                message: `Connection #${idx + 1}: Uses outdated topper port format (should use grouped ports)`
              });
            }
          } else {
            // Regular port - check index is valid
            const portIdx = parseInt(conn.fromPortIdx);
            if (!isNaN(portIdx) && portIdx >= sourceMachineDef.outputs) {
              issues.push({
                type: 'invalid-port',
                connection: idx,
                message: `Connection #${idx + 1}: Output port ${portIdx} doesn't exist (machine has ${sourceMachineDef.outputs} outputs)`
              });
            }
          }
        }
      }

      // Validate target port exists
      const targetMachine = placedMachines.find(pm => pm.id === conn.toMachineId);
      if (targetMachine) {
        const targetMachineDef = getMachineById(targetMachine.machineId);
        if (targetMachineDef) {
          // Check if it's a heating device with grouped ports
          if (targetMachineDef.kind === "heating_device" && typeof conn.toPortIdx === 'string') {
            if (conn.toPortIdx === 'fuel') {
              // Valid fuel port
            } else if (conn.toPortIdx.startsWith('grouped-input-')) {
              // Validate the material exists
              const materialId = conn.toPortIdx.replace(/^grouped-input-/, '');
              if (!getMaterialById(materialId)) {
                issues.push({
                  type: 'invalid-port',
                  connection: idx,
                  message: `Connection #${idx + 1}: Input port references non-existent material`
                });
              }
            } else if (conn.toPortIdx.startsWith('topper-')) {
              // Old topper port format - flag as outdated
              issues.push({
                type: 'outdated-port',
                connection: idx,
                message: `Connection #${idx + 1}: Uses outdated topper port format (should use grouped ports)`
              });
            }
          } else {
            // Regular port - check index is valid
            const portIdx = parseInt(conn.toPortIdx);
            if (!isNaN(portIdx) && portIdx >= targetMachineDef.inputs) {
              issues.push({
                type: 'invalid-port',
                connection: idx,
                message: `Connection #${idx + 1}: Input port ${portIdx} doesn't exist (machine has ${targetMachineDef.inputs} inputs)`
              });
            }
          }
        }
      }
    });

    return issues;
  }

  
  /**
   * Normalize a build-like object into a safe build payload.
   * @param {any} raw
   * @returns {{ placedMachines: Array<any>, connections: Array<any>, camera: { x: number, y: number, zoom: number } }}
   */
  function normalizeBuildData(raw) {
    const parsed = raw && typeof raw === "object" ? raw : {};

    const placedMachines = Array.isArray(parsed.placedMachines)
      ? parsed.placedMachines.map(pm => {
        const normalized = {
          ...pm,
          type: pm.type || "machine",
          count: pm.count || 1,
        };
        if (pm.type === "purchasing_portal") {
          normalized.materialId = pm.materialId || null;
        }
        // Legacy compat: Fuel Source node was removed. Convert to Purchasing Portal (fuelId -> materialId).
        if (pm.type === "fuel_source") {
          normalized.type = "purchasing_portal";
          normalized.materialId = pm.fuelId || null;
          delete normalized.fuelId;
        }
        if (pm.type === "nursery") {
          normalized.plantId = pm.plantId || null;
          normalized.fertilizerId = pm.fertilizerId || null;
        }
        // Storage / heating device extra fields (type === "machine")
        if (pm.type === "machine" && pm.machineId) {
          normalized.storageSlots = Number.isFinite(pm.storageSlots) && pm.storageSlots > 0
            ? Math.trunc(pm.storageSlots)
            : null;
          normalized.inventories = Array.isArray(pm.inventories) ? pm.inventories : [];
          normalized.manualInventories = Array.isArray(pm.manualInventories) ? pm.manualInventories : [];
          normalized.toppers = Array.isArray(pm.toppers) ? pm.toppers : [];
          normalized.previewFuelId = typeof pm.previewFuelId === "string" ? pm.previewFuelId : null;
        }
        return normalized;
      })
      : [];

    const connections = Array.isArray(parsed.connections) ? parsed.connections : [];

    const camera = parsed.camera && typeof parsed.camera === "object"
      ? {
        x: Number(parsed.camera.x) || 0,
        y: Number(parsed.camera.y) || 0,
        zoom: Number(parsed.camera.zoom) || 1.0
      }
      : { x: 0, y: 0, zoom: 1.0 };

    return { placedMachines, connections, camera };
  }

  function loadBuildFromLegacyStorage() {
    const raw = localStorage.getItem(BUILD_STORAGE_KEY);
    if (!raw) return { placedMachines: [], connections: [], camera: { x: 0, y: 0, zoom: 1.0 } };
    try {
      return normalizeBuildData(JSON.parse(raw));
    } catch {
      return { placedMachines: [], connections: [], camera: { x: 0, y: 0, zoom: 1.0 } };
    }
  }

  /**
   * Public load build helper:
   * - Prefer the active workspace tab build (if present)
   * - Fall back to legacy build key
   */
  function loadBuild() {
    const tab = getActiveWorkspaceTab();
    if (tab && tab.build) return normalizeBuildData(tab.build);
    return loadBuildFromLegacyStorage();
  }

  function getActiveWorkspaceTab() {
    const activeId = state.workspaces?.activeId ?? null;
    if (!activeId) return null;
    return (state.workspaces.tabs || []).find(t => t.id === activeId) ?? null;
  }

  function getNextDefaultWorkspaceName() {
    const n = Array.isArray(state.workspaces?.tabs) ? state.workspaces.tabs.length + 1 : 1;
    return `New Production ${n}`;
  }

  function saveWorkspaces() {
    const payload = {
      version: 1,
      activeId: state.workspaces.activeId,
      tabs: (state.workspaces.tabs || []).map(t => ({
        id: t.id,
        name: typeof t.name === "string" ? t.name : "",
        build: t.build || { placedMachines: [], connections: [], camera: { x: 0, y: 0, zoom: 1.0 } },
      })),
    };
    localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(payload, null, 2));
  }

  function loadWorkspaces() {
    const raw = localStorage.getItem(WORKSPACES_STORAGE_KEY);
    if (!raw) {
      // Migration: if legacy build exists, use it as first workspace.
      const legacyBuild = loadBuildFromLegacyStorage();
      const firstTab = {
        id: makeId("ws"),
        name: "New Production 1",
        build: legacyBuild,
      };
      state.workspaces.tabs = [firstTab];
      state.workspaces.activeId = firstTab.id;
      saveWorkspaces();
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      const tabs = Array.isArray(parsed.tabs) ? parsed.tabs : [];
      const normalizedTabs = tabs
        .filter(t => t && typeof t === "object")
        .map((t, idx) => ({
          id: typeof t.id === "string" ? t.id : makeId("ws"),
          name: (typeof t.name === "string" && t.name.trim()) ? t.name.trim() : `New Production ${idx + 1}`,
          build: normalizeBuildData(t.build || t),
        }));

      state.workspaces.tabs = normalizedTabs.length ? normalizedTabs : [{
        id: makeId("ws"),
        name: "New Production 1",
        build: loadBuildFromLegacyStorage(),
      }];

      const requestedActive = typeof parsed.activeId === "string" ? parsed.activeId : null;
      const resolvedActive = (requestedActive && state.workspaces.tabs.some(t => t.id === requestedActive))
        ? requestedActive
        : state.workspaces.tabs[0].id;
      state.workspaces.activeId = resolvedActive;
    } catch {
      state.workspaces.tabs = [{
        id: makeId("ws"),
        name: "New Production 1",
        build: loadBuildFromLegacyStorage(),
      }];
      state.workspaces.activeId = state.workspaces.tabs[0].id;
    }
  }

  /**
   * @param {{ name: string, build?: { placedMachines: Array<any>, connections: Array<any>, camera?: any }, switchTo?: boolean }} opts
   */
  function createWorkspaceTab(opts) {
    const name = (opts?.name && String(opts.name).trim()) ? String(opts.name).trim() : getNextDefaultWorkspaceName();
    const build = opts?.build ? normalizeBuildData(opts.build) : { placedMachines: [], connections: [], camera: { x: 0, y: 0, zoom: 1.0 } };
    const tab = { id: makeId("ws"), name, build };
    state.workspaces.tabs.push(tab);
    if (opts?.switchTo) {
      switchWorkspaceTab(tab.id);
    } else {
      saveWorkspaces();
    }
    return tab;
  }

  function renameWorkspaceTab(tabId, newName) {
    const tab = (state.workspaces.tabs || []).find(t => t.id === tabId) ?? null;
    if (!tab) return false;
    const name = String(newName ?? "").trim();
    if (!name) return false;
    tab.name = name;
    saveWorkspaces();
    return true;
  }

  function switchWorkspaceTab(tabId) {
    if (!tabId) return false;
    if (state.currentBlueprintEdit || (state.blueprintEditStack && state.blueprintEditStack.length > 0)) {
      AF.ui?.dialog?.alert?.("Exit blueprint editing before switching tabs.", { title: "Cannot switch tab" });
      return false;
    }

    // Save current build into current tab before switching.
    saveBuild();

    const tab = (state.workspaces.tabs || []).find(t => t.id === tabId) ?? null;
    if (!tab) return false;

    state.workspaces.activeId = tab.id;
    saveWorkspaces();

    const build = normalizeBuildData(tab.build);
    state.build.placedMachines = build.placedMachines;
    state.build.connections = build.connections;
    state.build.camera = build.camera;
    state.build.selectedMachines = [];
    state.build.selectedConnection = null;

    // Clear transient UI state that should not leak between tabs.
    state.ui.dragState = null;
    state.ui.pendingStorageCoords = null;
    state.ui.pendingManualStorageMachineId = null;
    state.ui.pendingStorageReplacementId = null;
    state.ui.pendingHeatingDeviceId = null;
    state.ui.pendingBlueprintCoords = null;
    state.ui.justCompletedSelection = false;

    state.blueprintEditStack = [];
    state.currentBlueprintEdit = null;

    // Full recalc + render (topology changed)
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true });
    return true;
  }

  /**
   * Close a workspace tab. If closing the active tab, switches to an adjacent tab.
   * Returns false only when it cannot close (e.g. last remaining tab).
   * @param {string} tabId
   */
  function closeWorkspaceTab(tabId) {
    if (!tabId) return false;
    if (state.currentBlueprintEdit || (state.blueprintEditStack && state.blueprintEditStack.length > 0)) {
      AF.ui?.dialog?.alert?.("Exit blueprint editing before closing tabs.", { title: "Cannot close tab" });
      return false;
    }

    const tabs = state.workspaces.tabs || [];
    if (tabs.length <= 1) return false;

    // Persist current build before we mutate the tab list.
    saveBuild();

    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return false;

    const wasActive = state.workspaces.activeId === tabId;

    // Choose a new active tab if needed (adjacent preference).
    let nextActiveId = null;
    if (wasActive) {
      const right = tabs[idx + 1];
      const left = tabs[idx - 1];
      nextActiveId = (right && right.id) ? right.id : (left && left.id) ? left.id : null;
    }

    tabs.splice(idx, 1);

    if (!wasActive) {
      saveWorkspaces();
      return true;
    }

    // Switch to the selected remaining tab.
    if (!nextActiveId) {
      // Shouldn't happen because we disallow closing last tab.
      state.workspaces.activeId = tabs[0]?.id ?? null;
      saveWorkspaces();
      return false;
    }

    state.workspaces.activeId = nextActiveId;
    saveWorkspaces();

    const nextTab = tabs.find(t => t.id === nextActiveId) ?? null;
    const build = normalizeBuildData(nextTab?.build || null);
    state.build.placedMachines = build.placedMachines;
    state.build.connections = build.connections;
    state.build.camera = build.camera;
    state.build.selectedMachines = [];
    state.build.selectedConnection = null;

    // Clear transient UI state that should not leak between tabs.
    state.ui.dragState = null;
    state.ui.pendingStorageCoords = null;
    state.ui.pendingManualStorageMachineId = null;
    state.ui.pendingStorageReplacementId = null;
    state.ui.pendingHeatingDeviceId = null;
    state.ui.pendingBlueprintCoords = null;
    state.ui.justCompletedSelection = false;

    state.blueprintEditStack = [];
    state.currentBlueprintEdit = null;

    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: true });
    return true;
  }

  function saveSkills() {
    localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(state.skills, null, 2));
  }

  function saveUIPrefs() {
    const prefs = {
      sidebars: state.ui.sidebars,
    };
    localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs, null, 2));
  }

  function loadUIPrefs() {
    const raw = localStorage.getItem(UI_PREFS_STORAGE_KEY);
    if (!raw) {
      return {
        sidebars: {
          database: true,
          blueprints: false,
          production: false,
        },
      };
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        sidebars: parsed.sidebars || {
          database: true,
          blueprints: false,
          production: false,
        },
      };
    } catch {
      return {
        sidebars: {
          database: true,
          blueprints: false,
          production: false,
        },
      };
    }
  }

  function loadSkills() {
    const raw = localStorage.getItem(SKILLS_STORAGE_KEY);
    const defaults = {
      conveyorSpeed: 0,
      throwingSpeed: 0,
      machineEfficiency: 0,
      alchemyEfficiency: 0,
      fuelEfficiency: 0,
      fertilizerEfficiency: 0,
      shopProfit: 0,
    };
    if (!raw) return defaults;
    try {
      const parsed = JSON.parse(raw);
      return {
        conveyorSpeed: Number(parsed.conveyorSpeed) || 0,
        throwingSpeed: Number(parsed.throwingSpeed) || 0,
        machineEfficiency: Number(parsed.machineEfficiency) || 0,
        alchemyEfficiency: Number(parsed.alchemyEfficiency) || 0,
        fuelEfficiency: Number(parsed.fuelEfficiency) || 0,
        fertilizerEfficiency: Number(parsed.fertilizerEfficiency) || 0,
        shopProfit: Number(parsed.shopProfit) || 0,
      };
    } catch {
      return defaults;
    }
  }

  // ---------- Settings ----------

  function getDefaultSettings() {
    return {
      version: 1,
      costBlueprints: {
        fuel: { blueprintId: null, outputMaterialId: null },
        fertilizer: { blueprintId: null, outputMaterialId: null },
      },
    };
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings || getDefaultSettings(), null, 2));
  }

  function loadSettings() {
    const defaults = getDefaultSettings();
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    try {
      const parsed = JSON.parse(raw);
      const out = getDefaultSettings();
      if (parsed && typeof parsed === "object") {
        const cb = parsed.costBlueprints || {};
        const fuel = cb.fuel || {};
        const fert = cb.fertilizer || {};
        out.costBlueprints.fuel.blueprintId = typeof fuel.blueprintId === "string" ? fuel.blueprintId : null;
        out.costBlueprints.fuel.outputMaterialId = typeof fuel.outputMaterialId === "string" ? fuel.outputMaterialId : null;
        out.costBlueprints.fertilizer.blueprintId = typeof fert.blueprintId === "string" ? fert.blueprintId : null;
        out.costBlueprints.fertilizer.outputMaterialId = typeof fert.outputMaterialId === "string" ? fert.outputMaterialId : null;
      }
      return out;
    } catch {
      return defaults;
    }
  }

  // Persistence + loading helpers shared across layers
  Object.assign(AF.core, {
    saveDb,
    loadDb,
    clearDb,
    exportDb,
    exportFullState,
    exportBuildState,
    importFullState,
    importBuildState,
    saveBuild,
    loadBuild,
    // Workspaces (production tabs)
    saveWorkspaces,
    loadWorkspaces,
    getActiveWorkspaceTab,
    createWorkspaceTab,
    renameWorkspaceTab,
    switchWorkspaceTab,
    closeWorkspaceTab,
    saveSkills,
    loadSkills,
    saveUIPrefs,
    loadUIPrefs,
    saveSettings,
    loadSettings,
    validateBuild
  });








  /**
   * Normalize the database
   * @param {Db} db
   * @returns {Db}
   */
  function normalizeDb(db) {
    if (!db || typeof db !== "object") return createEmptyDb();
    const normalized = {
      version: SCHEMA_VERSION,
      meta: {
        createdAt: typeof db.meta?.createdAt === "string" ? db.meta.createdAt : new Date().toISOString(),
        updatedAt: typeof db.meta?.updatedAt === "string" ? db.meta.updatedAt : new Date().toISOString(),
      },
      materials: Array.isArray(db.materials) ? db.materials : [],
      machines: Array.isArray(db.machines) ? db.machines : [],
      recipes: Array.isArray(db.recipes) ? db.recipes : [],
      blueprints: Array.isArray(db.blueprints) ? db.blueprints : [],
    };
    // Ensure required fields minimally exist for each item
    normalized.materials = normalized.materials
      .filter((m) => m && typeof m === "object")
      .map((m) => ({
        id: typeof m.id === "string" ? m.id : makeId("mat"),
        name: typeof m.name === "string" ? m.name : "Unnamed Material",
        buyPrice: Number.isFinite(m.buyPrice) ? m.buyPrice : null,
        salePrice: Number.isFinite(m.salePrice) ? m.salePrice : null,
        isFuel: Boolean(m.isFuel),
        fuelValue: Number.isFinite(m.fuelValue) ? m.fuelValue : null,
        isFertilizer: Boolean(m.isFertilizer),
        fertilizerNutrientValue: Number.isFinite(m.fertilizerNutrientValue) ? m.fertilizerNutrientValue : null,
        fertilizerMaxFertility: Number.isFinite(m.fertilizerMaxFertility) ? m.fertilizerMaxFertility : null,
        isPlant: Boolean(m.isPlant),
        plantRequiredNutrient: Number.isFinite(m.plantRequiredNutrient) ? m.plantRequiredNutrient : null,
        stackSize: Number.isFinite(m.stackSize) && m.stackSize > 0 ? Math.trunc(m.stackSize) : 1,
      }));
    normalized.machines = normalized.machines
      .filter((x) => x && typeof x === "object")
      .map((x) => {
        // Migrate old "furnace" to "heating_device"
        let kind = x.kind;
        if (kind === "furnace") kind = "heating_device";
        if (!["standard", "heating_device", "storage", "nursery"].includes(kind)) kind = "standard";

        return {
          id: typeof x.id === "string" ? x.id : makeId("mac"),
          name: typeof x.name === "string" ? x.name : "Unnamed Machine",
          inputs: Number.isFinite(x.inputs) ? Math.max(0, Math.trunc(x.inputs)) : 0,
          outputs: Number.isFinite(x.outputs) ? Math.max(0, Math.trunc(x.outputs)) : 0,
          requiresFurnace: Boolean(x.requiresFurnace),
          heatConsumptionP: Number.isFinite(x.heatConsumptionP) ? Number(x.heatConsumptionP) : null,
          kind: kind,
          baseHeatConsumptionP:
            kind === "heating_device" && Number.isFinite(x.baseHeatConsumptionP) ? Number(x.baseHeatConsumptionP) : 1,
          storageSlots: kind === "storage" && Number.isFinite(x.storageSlots) && x.storageSlots > 0
            ? Math.trunc(x.storageSlots)
            : null,
          // Heating device fields
          heatingAreaWidth: kind === "heating_device" && Number.isFinite(x.heatingAreaWidth) && x.heatingAreaWidth > 0
            ? Math.trunc(x.heatingAreaWidth)
            : null,
          heatingAreaLength: kind === "heating_device" && Number.isFinite(x.heatingAreaLength) && x.heatingAreaLength > 0
            ? Math.trunc(x.heatingAreaLength)
            : null,
          // Footprint fields for machines that require heating devices
          footprintWidth: x.requiresFurnace && Number.isFinite(x.footprintWidth) && x.footprintWidth > 0
            ? Math.trunc(x.footprintWidth)
            : null,
          footprintLength: x.requiresFurnace && Number.isFinite(x.footprintLength) && x.footprintLength > 0
            ? Math.trunc(x.footprintLength)
            : null,
        };
      });
    normalized.recipes = normalized.recipes
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        id: typeof r.id === "string" ? r.id : makeId("rec"),
        name: typeof r.name === "string" ? r.name : "Unnamed Recipe",
        machineId: typeof r.machineId === "string" ? r.machineId : "",
        processingTimeSec: Number.isFinite(r.processingTimeSec) ? Math.max(0.0001, Number(r.processingTimeSec)) : 1,
        inputs: Array.isArray(r.inputs) ? r.inputs : [],
        outputs: Array.isArray(r.outputs) ? r.outputs : [],
        heatConsumptionP: Number.isFinite(r.heatConsumptionP) ? Number(r.heatConsumptionP) : null,
      }))
      .map((r) => ({
        ...r,
        inputs: normalizeIoList(r.inputs),
        outputs: normalizeIoList(r.outputs),
      }));

    return normalized;
  }

  /**
   * Normalize the input/output list
   * @param {Array<RecipeIO>} list
   * @returns {Array<RecipeIO>}
   */
  function normalizeIoList(list) {
    return list
      .filter((x) => x && typeof x === "object")
      .map((x) => ({
        materialId: typeof x.materialId === "string" ? x.materialId : "",
        items: Number.isFinite(x.items) ? Number(x.items) : (Number.isFinite(x.ppm) ? Number(x.ppm) : 0), // backward compat: ppm → items
      }));
  }








  // ---------- Query helpers ----------

  function getMaterialById(id) {
    return state.db.materials.find((m) => m.id === id) ?? null;
  }

  function getMachineById(id) {
    return state.db.machines.find((m) => m.id === id) ?? null;
  }

  function getRecipeById(id) {
    return state.db.recipes.find((r) => r.id === id) ?? null;
  }
  
  /**
   * Find a machine by ID, searching through the entire tree (including blueprint children)
   * @param {string} machineId - Machine ID to find
   * @returns {object|null} Machine object or null if not found
   */
  function findMachineInTree(machineId) {
    // Check top-level machines
    for (const pm of AF.state.build.placedMachines) {
      if (pm.id === machineId) return pm;
      
      // Check inside blueprint instances
      if ((pm.type === "blueprint_instance" || pm.type === "blueprint") && pm.childMachines) {
        for (const child of pm.childMachines) {
          if (child.id === machineId) return child;
          
          // Recursively check nested blueprints
          if ((child.type === "blueprint_instance" || child.type === "blueprint") && child.childMachines) {
            const nested = findMachineInTreeRecursive(machineId, child.childMachines);
            if (nested) return nested;
          }
        }
      }
    }
    
    return null;
  }
  
  function findMachineInTreeRecursive(machineId, machines) {
    for (const pm of machines) {
      if (pm.id === machineId) return pm;
      
      if ((pm.type === "blueprint_instance" || pm.type === "blueprint") && pm.childMachines) {
        const nested = findMachineInTreeRecursive(machineId, pm.childMachines);
        if (nested) return nested;
      }
    }
    return null;
  }

   /**
   * Get all machines in tree (including blueprint children)
   * @returns {Array} All machines (top-level and children)
   */
   function getAllMachinesInTree() {
    const allMachines = [];
    
    function traverse(machines) {
      machines.forEach(pm => {
        // Blueprint instances are containers, not machines - skip them in calculations
        // Only collect their child machines (the real machines)
        if ((pm.type === "blueprint_instance" || pm.type === "blueprint") && pm.childMachines) {
          traverse(pm.childMachines);
        } else {
          // Regular machine - add it to calculations
          allMachines.push(pm);
        }
      });
    }
    
    traverse(AF.state.build.placedMachines);
    return allMachines;
  }
  
  /**
   * Get all connections in tree (including blueprint internal connections)
   * Resolves external connections to internal machines where applicable
   * @returns {Array} All connections (top-level and internal, resolved)
   */
  function getAllConnectionsInTree() {
    const allConnections = [];
    
    // Top-level connections (resolve to internal machines if needed)
    AF.state.build.connections.forEach(conn => {
      const resolved = resolveConnection(conn);
      allConnections.push(resolved);
    });
    
    // Internal blueprint connections
    function collectInternalConnections(machines) {
      machines.forEach(pm => {
        if ((pm.type === "blueprint_instance" || pm.type === "blueprint") && pm.childConnections) {
          allConnections.push(...pm.childConnections);
          
          // Recurse for nested blueprints
          if (pm.childMachines) {
            collectInternalConnections(pm.childMachines);
          }
        }
      });
    }
    
    collectInternalConnections(AF.state.build.placedMachines);
    return allConnections;
  }

  /**
   * Resolve a connection to internal machines if it connects to/from a blueprint
   * @param {object} connection - Connection to resolve
   * @returns {object} Connection with _resolved* fields added if applicable
   */
  function resolveConnection(connection) {
    // Mutate the original connection object to add resolved fields
    // This ensures actualRate and other properties set on resolved connections
    // are accessible from the original connection objects in AF.state.build.connections
    
    // Resolve TO machine (if blueprint, resolve to internal machine)
    const toMachine = findMachineInTree(connection.toMachineId);
    if (toMachine && (toMachine.type === "blueprint_instance" || toMachine.type === "blueprint")) {
      if (toMachine.portMappings && toMachine.portMappings.inputs) {
        const mapping = toMachine.portMappings.inputs[connection.toPortIdx];
        if (mapping) {
          connection._resolvedToMachineId = mapping.internalMachineId;
          connection._resolvedToPortIdx = mapping.internalPortIdx;
        }
      }
    }
    
    // Resolve FROM machine (if blueprint, resolve to internal machine)
    const fromMachine = findMachineInTree(connection.fromMachineId);
    if (fromMachine && (fromMachine.type === "blueprint_instance" || fromMachine.type === "blueprint")) {
      if (fromMachine.portMappings && fromMachine.portMappings.outputs) {
        const mapping = fromMachine.portMappings.outputs[connection.fromPortIdx];
        if (mapping) {
          connection._resolvedFromMachineId = mapping.internalMachineId;
          connection._resolvedFromPortIdx = mapping.internalPortIdx;
        }
      }
    }
    
    return connection;
  }

   /**
   * Get material ID from a machine's port
   * @param {PlacedMachine} placedMachine
   * @param {number} portIdx
   * @param {string} type
   * @returns {string|null} Material ID or null
   */
   function getMaterialIdFromPort(placedMachine, portIdx, type) {
    // Blueprint types (both old and new)
    if (placedMachine.type === "blueprint" || placedMachine.type === "blueprint_instance") {
      const portIdxNum = parseInt(portIdx);

      // Try new physical model first (port mappings)
      if (placedMachine.portMappings) {
        if (type === "input") {
          const mapping = placedMachine.portMappings.inputs?.[portIdxNum];
          return mapping?.materialId || null;
        } else {
          const mapping = placedMachine.portMappings.outputs?.[portIdxNum];
          return mapping?.materialId || null;
        }
      }

      // Fall back to old model (blueprintData)
      const bpData = placedMachine.blueprintData || {};
      if (type === "input") {
        const input = bpData.inputs?.[portIdxNum];
        return input?.materialId || null;
      } else {
        const output = bpData.outputs?.[portIdxNum];
        return output?.materialId || null;
      }
    }

    // Purchasing portal
    if (placedMachine.type === "purchasing_portal") {
      return placedMachine.materialId;
    }

    if (placedMachine.type === "nursery") {
      if (type === "output") {
        return placedMachine.plantId;
      } else {
        // Input port - determine fertilizer from connection or selection
        // First check if there's a connected source
        const incomingConnections = state.build.connections.filter(conn => conn.toMachineId === placedMachine.id);
        if (incomingConnections.length > 0) {
          const sourceConn = incomingConnections[0];
          const sourceMachine = state.build.placedMachines.find(pm => pm.id === sourceConn.fromMachineId);
          if (sourceMachine) {
            const fertId = getMaterialIdFromPort(sourceMachine, sourceConn.fromPortIdx, "output");
            if (fertId) return fertId;
          }
        }
        // Otherwise use selected fertilizer
        return placedMachine.fertilizerId || null;
      }
    }

    // Check if this is a heating device with grouped ports (portIdx is a string like "grouped-input-materialId" or "grouped-output-materialId")
    const machine = getMachineById(placedMachine.machineId);
    if (machine && machine.kind === "heating_device" && typeof portIdx === 'string') {
      // Handle grouped ports
      if (portIdx.startsWith('grouped-input-') || portIdx.startsWith('grouped-output-')) {
        const materialId = portIdx.replace(/^grouped-(input|output)-/, '');
        return materialId || null;
      }

      // Handle individual topper ports (legacy, for backward compatibility)
      if (portIdx.startsWith('topper-')) {
        const match = portIdx.match(/^topper-(\d+)-(\d+)$/);
        if (match) {
          const topperIdx = parseInt(match[1]);
          const topperPortIdx = parseInt(match[2]);
          const topper = placedMachine.toppers?.[topperIdx];
          if (topper && topper.recipeId) {
            const topperRecipe = getRecipeById(topper.recipeId);
            if (topperRecipe) {
              if (type === "output") {
                return topperRecipe.outputs[topperPortIdx]?.materialId || null;
              } else {
                return topperRecipe.inputs[topperPortIdx]?.materialId || null;
              }
            }
          }
        }
        return null;
      }
    }

    // Storage machine - return material from inventories
    if (machine && machine.kind === "storage" && type === "output") {
      // Check manual inventories first
      const manualInventories = placedMachine.manualInventories || [];
      if (manualInventories.length > 0) {
        // Return the first material (storage can output any stored material)
        return manualInventories[0]?.materialId || null;
      }

      // Check incoming connections to determine what material is flowing through
      const incomingConnections = state.build.connections.filter(
        conn => conn.toMachineId === placedMachine.id
      );

      if (incomingConnections.length > 0) {
        // Get material from first input connection
        const sourceConn = incomingConnections[0];
        const sourceMachine = state.build.placedMachines.find(pm => pm.id === sourceConn.fromMachineId);
        if (sourceMachine) {
          return getMaterialIdFromPort(sourceMachine, sourceConn.fromPortIdx, "output");
        }
      }

      return null;
    }

    // Regular machine with recipe
    const recipe = placedMachine.recipeId ? getRecipeById(placedMachine.recipeId) : null;
    if (!recipe) return null;

    if (type === "output") {
      return recipe.outputs[portIdx]?.materialId || null;
    } else {
      return recipe.inputs[portIdx]?.materialId || null;
    }
  }

  function materialLabel(matId) {
    const m = getMaterialById(matId);
    return m ? m.name : "(missing material)";
  }



  Object.assign(AF.core, {
    getMaterialById,
    getMachineById,
    getRecipeById,
    findMachineInTree,
    getAllMachinesInTree,
    getAllConnectionsInTree,
    resolveConnection,
    materialLabel,
    getMaterialIdFromPort
  });


  // ---------- Calc/Render Scheduler ----------
  // Ensures calculations happen before render, coalesced per tick/idle period.
  AF.scheduler = AF.scheduler || {};
  (function() {
    let scheduled = false;
    let calcDirty = true; // initial load requires calculation
    let renderDirty = true;
    let forceRecreate = true;

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      const run = () => {
        scheduled = false;

        if (calcDirty) {
          try {
            if (!AF.calculator || typeof AF.calculator.recalculateAll !== "function") {
              throw new Error("AF.calculator.recalculateAll is not available. Ensure calculator.app.js exports it before app.js runs.");
            }
            AF.calculator.recalculateAll();
          } finally {
            calcDirty = false;
          }
        }

        if (renderDirty) {
          try {
            if (!AF.render || typeof AF.render.renderCanvasImpl !== "function") {
              throw new Error("AF.render.renderCanvasImpl is not available. Ensure render.app.js exports it before app.js runs.");
            }

            if (!AF.render || typeof AF.render.renderCanvasImpl !== "function") {
              throw new Error("AF.render.renderCanvasImpl is not available. Ensure render.app.js exports it before app.js runs.");
            }
            AF.render.renderCanvasImpl(forceRecreate);
            forceRecreate = false;

            AF.ui?.updateSelectionClasses?.();
            AF.ui.renderAllUIElements();

            if (state.ui.sidebars.production) {
              AF.ui.renderProductionSummary();
            }

            // `renderAllUIElements()` may change the layout grid columns, which changes the canvas size.
            // Re-apply the camera transform after layout settles so the visual camera matches the
            // stored camera coords on initial load.
            setTimeout(() => AF.render?.updateCameraTransform?.(), 0);
          } finally {
            renderDirty = false;
          }
        }
      };

      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(run, { timeout: 200 });
      } else {
        window.setTimeout(run, 0);
      }
    };

    /**
     * Invalidates the scheduler and queues a redender
     * @param {Object} opts - The options for the invalidate operation
     * @param {boolean} opts.needsRecalc - Whether to recalculate the scheduler - when a mutaion of data occurs.
     * @param {boolean} opts.needsRender - Whether to render the scheduler - pure UI only changes, no data manipulation.
     * @param {boolean} opts.forceRecreate - Whether to force a recreation of the DOM elements.
     */
    AF.scheduler.invalidate = (opts = {}) => {
      if (opts.needsRecalc) calcDirty = true;
      if (opts.needsRender) renderDirty = true;
      if (opts.forceRecreate) forceRecreate = true;
      schedule();
    };

    AF.scheduler.flushNow = () => {
      // Force immediate run (used in init)
      calcDirty = true;
      renderDirty = true;
      forceRecreate = true;
      schedule();
    };
  })();

  /**
   * Returns true if any persistent "state" exists in localStorage.
   * (UI prefs are intentionally ignored; we only care about actual app data.)
   */
  function hasAnyPersistedState() {
    try {
      return Boolean(
        localStorage.getItem(STORAGE_KEY) ||
          localStorage.getItem(WORKSPACES_STORAGE_KEY) ||
          localStorage.getItem(BUILD_STORAGE_KEY) ||
          localStorage.getItem(SKILLS_STORAGE_KEY) ||
          localStorage.getItem(SETTINGS_STORAGE_KEY)
      );
    } catch {
      // If localStorage is unavailable for any reason, treat as "has state"
      // so we don't attempt network/file fetches unexpectedly.
      return true;
    }
  }

  /**
   * Fetch `./alchemy-factory-state.json` and run it through the existing import routine.
   * This is used only on first run (when no persisted state exists).
   */
  async function bootstrapFromBundledState() {
    AF.ui?.setStatus?.("No local data found. Loading bundled starter state…", "info");

    const res = await fetch("./alchemy-factory-state.json", { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Failed to fetch bundled state (HTTP ${res.status})`);
    }

    const text = await res.text();

    // `importFullState` only needs a `.text()` method, so we can provide a lightweight shim.
    await importFullState({
      text: async () => text,
    });
  }






  async function init() {
    // First run bootstrap:
    // If there is no persisted state at all, pull down the bundled starter state file and
    // feed it through the existing import routine. From that point on, localStorage wins.
    const shouldBootstrapFromBundledState = !hasAnyPersistedState();

    state.db = loadDb();
    loadWorkspaces();
    const buildData = loadBuild();
    state.build.placedMachines = buildData.placedMachines;
    state.build.connections = buildData.connections;
    state.build.camera = buildData.camera || { x: 0, y: 0, zoom: 1.0 };
    state.skills = loadSkills();
    state.settings = loadSettings();

    // Load UI preferences (sidebar states)
    const uiPrefs = loadUIPrefs();
    state.ui.sidebars = uiPrefs.sidebars;

    // Apply sidebar visibility based on loaded preferences
    if (state.ui.sidebars.database) {
      $("#databaseSidebar")?.classList.remove("hidden");
    } else {
      $("#databaseSidebar")?.classList.add("hidden");
    }

    if (state.ui.sidebars.blueprints) {
      $("#blueprintsSidebar")?.classList.remove("hidden");
    } else {
      $("#blueprintsSidebar")?.classList.add("hidden");
    }

    if (state.ui.sidebars.production) {
      $("#productionSidebar")?.classList.remove("hidden");
    } else {
      $("#productionSidebar")?.classList.add("hidden");
    }

    if (!AF.calculator || typeof AF.calculator.init !== "function") {
      throw new Error("AF.calculator.init is not available. Ensure calculator.app.js exports it before app.js runs.");
    }
    if (!AF.render || typeof AF.render.init !== "function") {
      throw new Error("AF.render.init is not available. Ensure render.app.js exports it before app.js runs.");
    }
    if (!AF.ui || typeof AF.ui.init !== "function") {
      throw new Error("AF.ui.init is not available. Ensure ui.app.js exports it before app.js runs.");
    }

    // Allow modules to set up internal wiring after state is ready
    AF.calculator.init();
    AF.ui.init();
    AF.render.init();

    if (shouldBootstrapFromBundledState) {
      // Do not block startup if this fails (e.g. file:// mode, missing asset, offline).
      try {
        await bootstrapFromBundledState();
      } catch (err) {
        console.warn("[AF] Bundled starter state bootstrap failed:", err);
        AF.ui?.setStatus?.("No local data found, but bundled starter state could not be loaded. Starting empty.", "warn");
      }
    }

    // Initial calculation + render (coalesced)
    AF.scheduler.flushNow();

    // Ensure camera transform is applied after layout settles
    setTimeout(() => (AF.render?.updateCameraTransform ? AF.render.updateCameraTransform() : null), 0);

    AF.ui.setStatus("Ready.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

 })();

