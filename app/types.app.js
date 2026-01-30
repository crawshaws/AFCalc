/**
 * `types.app.js`
 *  - IntelliSense/JSDoc type hub for the whole application
 *  - This file is referenced by `shared.app.js` via `/// <reference path="types.app.js" />`
 *  - It is NOT required to be loaded by `index.html` at runtime (classic scripts / file:// safe)
 *
 * Goal: provide the IDE with a full understanding of `window.AF` and the `AF.*` namespaces.
 */

// ---------- Domain model (DB) ----------

/**
 * @typedef {{ createdAt: string, updatedAt: string }} DbMeta
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   buyPrice: (number|null),
 *   salePrice: (number|null),
 *   stackSize: number,
 *
 *   // Fuel
 *   isFuel: boolean,
 *   fuelValue: (number|null),
 *
 *   // Fertilizer
 *   isFertilizer: boolean,
 *   fertilizerNutrientValue: (number|null),
 *   fertilizerMaxFertility: (number|null),
 *
 *   // Plants (nursery output is a "material" id)
 *   isPlant: boolean,
 *   plantRequiredNutrient: (number|null),
 * }} Material
 */

/**
 * @typedef {"standard"|"heating_device"|"storage"|"nursery"} MachineKind
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   kind: MachineKind,
 *   inputs: number,
 *   outputs: number,
 *
 *   // Heating / furnace-esque
 *   requiresFurnace: boolean,
 *   heatConsumptionP: (number|null),
 *   baseHeatConsumptionP: number,
 *   heatingAreaWidth: (number|null),
 *   heatingAreaLength: (number|null),
 *   footprintWidth: (number|null),
 *   footprintLength: (number|null),
 *
 *   // Storage-specific
 *   storageSlots: (number|null),
 * }} Machine
 */

/**
 * @typedef {{ materialId: string, items: number }} RecipeIO
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   machineId: string,
 *   processingTimeSec: number,
 *   heatConsumptionP: (number|null),
 *   inputs: Array<RecipeIO>,
 *   outputs: Array<RecipeIO>,
 * }} Recipe
 */

/**
 * @typedef {{ fromMachineId: string, fromPortIdx: number, toMachineId: string, toPortIdx: number }} BlueprintConnection
 */

/**
 * @typedef {{ materialId: string, rate: number }} BlueprintPortSpec
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   machines: Array<Object>,
 *   connections: Array<BlueprintConnection>,
 *   inputs: Array<BlueprintPortSpec>,
 *   outputs: Array<BlueprintPortSpec>,
 *   createdAt: (string|undefined),
 * }} Blueprint
 */

/**
 * @typedef {{
 *   version: number,
 *   meta: DbMeta,
 *   materials: Array<Material>,
 *   machines: Array<Machine>,
 *   recipes: Array<Recipe>,
 *   blueprints: Array<Blueprint>,
 * }} Db
 */

// ---------- Build canvas ----------

/**
 * @typedef {{
 *   x: number,
 *   y: number,
 *   zoom: number,
 * }} CameraState
 */

/**
 * @typedef {{
 *   // Port index -> mapping
 *   inputs: (Array<{ materialId: string, internalMachineId: string, internalPortIdx: number }> | undefined),
 *   outputs: (Array<{ materialId: string, internalMachineId: string, internalPortIdx: number }> | undefined),
 * }} BlueprintPortMappings
 */

/**
 * @typedef {"machine"|"purchasing_portal"|"nursery"|"storage"|"export"|"blueprint"|"blueprint_instance"|"virtual_sink"|"virtual_source"} PlacedMachineType
 */

/**
 * @typedef {{
 *   id: string,
 *   type: PlacedMachineType,
 *   x: number,
 *   y: number,
 *
 *   // Common optional fields
 *   count: (number|undefined),
 *   efficiency: (number|undefined),
 *
 *   // Standard machines
 *   machineId: (string|null|undefined),
 *   recipeId: (string|null|undefined),
 *
 *   // Portal/source types
 *   materialId: (string|null|undefined),
 *   plantId: (string|null|undefined),
 *   fertilizerId: (string|null|undefined),
 *
 *   // Storage
 *   storageSlots: (number|undefined),
 *   manualInventories: (Array<{ materialId: string, slotsAllocated: number, currentAmount: (number|undefined) }> | undefined),
 *
 *   // Heating device toppers (for heating devices only)
 *   toppers: (Array<{ machineId: string, recipeId?: (string|null) }> | undefined),
 *
 *   // Blueprint instances (new physical model)
 *   blueprintId: (string|undefined),
 *   detached: (boolean|undefined),
 *   childMachines: (Array<PlacedMachine>|undefined),
 *   childConnections: (Array<Connection>|undefined),
 *   portMappings: (BlueprintPortMappings|undefined),
 *
 *   // Blueprint instances (legacy compat)
 *   blueprintData: (Object|undefined),
 *
 *   // Calculator/runtime annotations
 *   actualInputRates: (Object.<string, number>|undefined),
 *   actualOutputRates: (Object.<string, number>|undefined),
 *   hasInsufficientInputs: (boolean|undefined),
 *   _isVirtual: (boolean|undefined),
 *   _parentBlueprintId: (string|undefined),
 *   _isChildMachine: (boolean|undefined),
 * }} PlacedMachine
 */

/**
 * @typedef {{
 *   id: (string|undefined),
 *   fromMachineId: string,
 *   fromPortIdx: number,
 *   toMachineId: string,
 *   toPortIdx: number,
 *   actualRate: (number|undefined),
 *   _parentBlueprintId: (string|undefined),
 *   materialId: (string|undefined),
 * }} Connection
 */

/**
 * @typedef {{
 *   placedMachines: Array<PlacedMachine>,
 *   connections: Array<Connection>,
 *   selectedMachines: Array<string>,
 *   selectedConnection: (string|null),
 *   camera: CameraState,
 * }} BuildState
 */

/**
 * @typedef {{
 *   materialId: string,
 *   materialName: string,
 *   currentAmount: number,
 *   capacity: number,
 *   slotsAllocated: number,
 *   inputRate: number,
 *   outputRate: number,
 *   netRate: number,
 *   timeToFillMinutes: number,
 *   status: string,
 *   timeDisplay: string,
 *   storedDisplay: string,
 * }} InventoryItem
 */

// ---------- Calculation snapshot (render must read, not compute) ----------

/**
 * @typedef {{ exports: Map<string, number>, imports: Map<string, number> }} CalcNetProduction
 */

/**
 * @typedef {{ totalCopper: number, breakdown: Map<string, number> }} PurchasingCosts
 */

/**
 * @typedef {{ rate: number, costPerMinute: number, material: Material, realizedCost: number }} ImportCostItem
 */

/**
 * @typedef {{ conveyorSpeed: number, effectiveConveyorSpeed: number }} CalcSkillSnapshot
 */

/**
 * @typedef {{
 *   outputRate: Map<string, number>,
 *   inputDemand: Map<string, number>,
 *   outputMaterial: Map<string, (string|null)>,
 *   inputMaterial: Map<string, (string|null)>,
 * }} CalcPortSnapshot
 */

/**
 * @typedef {{
 *   lastCalculatedAt: number,
 *   netProduction: (CalcNetProduction|null),
 *   sources: (Array<PlacedMachine>|null),
 *   sinks: (Array<PlacedMachine>|null),
 *   purchasingCosts: (PurchasingCosts|null),
 *   importCosts: (Map<string, ImportCostItem>|null),
 *   totalImportCost: number,
 *   totalCost: number,
 *   skill: (CalcSkillSnapshot|undefined),
 *
 *   fuelHeatValueByMaterialId: (Map<string, number>|undefined),
 *   fertilizerValueByMaterialId: (Map<string, number>|undefined),
 *   effectiveProcessingTimeByRecipeId: (Map<string, number>|undefined),
 *
 *   storageFillItems: (Array<{ storageId: string, storageName: string, materialId: string, materialName: string, netRate: number, inputRate: number, timeToFillMinutes: number }>|null),
 *   storageInventories: (Map<string, Array<Object>>|undefined),
 *
 *   blueprintMachineCounts: (Map<string, Object>|undefined),
 *   insufficientMachineIds: (Set<string>|undefined),
 *   storagePortRates: (Map<string, number>|undefined),
 *   uiByMachineId: (Map<string, Object>|undefined),
 *
 *   port: (CalcPortSnapshot|undefined),
 * }} CalcState
 */

// ---------- App state ----------

/**
 * @typedef {{
 *   conveyorSpeed: number,
 *   throwingSpeed: number,
 *   machineEfficiency: number,
 *   alchemyEfficiency: number,
 *   fuelEfficiency: number,
 *   fertilizerEfficiency: number,
 *   shopProfit: number,
 * }} SkillsState
 */

/**
 * @typedef {{
 *   activeTab: "materials"|"machines",
 *   selected: { materials: (string|null), machines: (string|null) },
 *   filters: { materials: string, machines: string },
 *   sidebars: { database: boolean, blueprints: boolean, production: boolean },
 *   statusTimer: (number|null),
 *
 *   pendingStorageCoords: (Object|null),
 *   pendingManualStorageMachineId: (string|null),
 *   pendingStorageReplacementId: (string|null),
 *   pendingHeatingDeviceId: (string|null),
 *   pendingBlueprintCoords: (Object|null),
 *   dragState: (Object|null),
 *   justCompletedSelection: boolean,
 *   productionSummaryDebounceTimer: (number|null),
 * }} UIState
 */

/**
 * @typedef {{
 *   placedMachines: Array<PlacedMachine>,
 *   connections: Array<Connection>,
 *   camera: CameraState,
 *   selectedMachines: Array<string>,
 *   editContext: (BlueprintEditContext|null),
 * }} BlueprintEditStackFrame
 */

/**
 * @typedef {{
 *   instanceId: (string|null),
 *   blueprintId: (string|null),
 *   detached: boolean,
 *   originalBlueprint: (Blueprint|null),
 *   childIdMap: (Map<any, any>|null),
 *   forceSaveAsNew: (boolean|undefined),
 *   startedFromSidebar: (boolean|undefined),
 * }} BlueprintEditContext
 */

/**
 * @typedef {{
 *   db: Db,
 *   calc: CalcState,
 *   ui: UIState,
 *   build: BuildState,
 *   blueprintEditStack: Array<BlueprintEditStackFrame>,
 *   currentBlueprintEdit: (BlueprintEditContext|null),
 *   blueprintMachineCountCache: Object,
 *   skills: SkillsState,
 * }} AppState
 */

/**
 * @typedef {{
 *   type: "missing-source"|"missing-target"|"invalid-port"|"outdated-port",
 *   connection: number,
 *   machineId: string,
 *   message: string,
 * }} ValidationIssue
 */

/**
 * @typedef {{
 *   materialId: string,
 *   rate: number,
 * }} MaterialRate
 */

/**
 * @typedef {{
 *   machines: Array<PlacedMachine>,
 *   inputs: Array<MaterialRate>,
 *   outputs: Array<MaterialRate>,
 * }} BlueprintAnalysisResult
 */

// ---------- AF public API surface ----------

/**
 * @typedef {{
 *   STORAGE_KEY: string,
 *   BUILD_STORAGE_KEY: string,
 *   SKILLS_STORAGE_KEY: string,
 *   UI_PREFS_STORAGE_KEY: string,
 *   SCHEMA_VERSION: number,
 *   CONVEYOR_SPEED: number,
 * }} AFConsts
 */

/**
 * @typedef {{
 *   $: (sel: string) => (Element|null),
 *   $$: (sel: string) => Array<Element>,
 *   saveDb: () => void,
 *   loadDb: () => Db,
 *   clearDb: () => void,
 *   exportDb: () => void,
 *   exportFullState: () => void,
 *   exportBuildState: () => void,
 *   importFullState: (file: File) => Promise<Array<ValidationIssue>>,
 *   saveBuild: () => void,
 *   loadBuild: () => { placedMachines: Array<PlacedMachine>, connections: Array<Connection>, camera: CameraState },
 *   saveSkills: () => void,
 *   loadSkills: () => SkillsState,
 *   saveUIPrefs: () => void,
 *   loadUIPrefs: () => { sidebars: UIState["sidebars"] },
 *   validateBuild: (placedMachines: Array<PlacedMachine>, connections: Array<Connection>) => Array<ValidationIssue>,
 *   getMaterialById: (id: string) => (Material|null),
 *   getMachineById: (id: string) => (Machine|null),
 *   getRecipeById: (id: string) => (Recipe|null),
 *   getMaterialIdFromPort: (placedMachine: PlacedMachine, portIdx: number, type: "input"|"output") => (string|null),
 *   compareByName: (a: { name?: string }, b: { name?: string }) => number,
 *   filterByName: (needle: string, item: { name?: string }) => boolean,
 *   materialLabel: (m: Material) => string,
 *   parseTimeString: (s: string) => (number|null),
 *   formatTimeString: (seconds: number) => string,
 *   formatTimeMinutes: (minutes: number) => string,
 *   formatCoins: (copper: number) => string,
 * }} AFCore
 */

/**
 * @typedef {{
 *   init: () => void,
 *   recalculateAll: () => void,
 *   calculateBlueprintMachineCounts: (blueprintId: string) => Object,
 *   invalidateBlueprintCountCache: (blueprintId: string) => void,
 *   analyzeBlueprintMachines: (selectedMachineIds: Array<string>) => BlueprintAnalysisResult,
 *   getConveyorSpeed: () => number,
 *   getEffectiveConveyorSpeed: () => number,
 *   getFuelConsumptionRate: (baseConsumptionP: number) => number,
 *   getFuelHeatValue: (totalBaseP: number) => number,
 *   getFertilizerValue: (totalBaseV: number) => number,
 *   getProfit: (basePriceC: number) => number,
 *   getAlchemyEfficiency: (baseOutput: number) => number,
 *   getEffectiveProcessingTime: (baseTime: number) => number
 * }} AFCalculator
 */

/**
 * @typedef {{
 *   init: () => void,
 *   renderCanvas: (forceRecreate?: boolean) => void,
 *   renderCanvasImpl: (forceRecreate?: boolean) => void,
 *   updateCameraTransform: () => void,
 *   syncRenderAfterCameraMove: () => void,
 *   renderConnections: (svgEl: SVGElement) => void,
 * }} AFRender
 */

/**
 * @typedef {{
 *   open: (opts?: {
 *     title?: string,
 *     message?: string,
 *     html?: string,
 *     contentEl?: Element,
 *     input?: { value?: string, placeholder?: string, selectOnOpen?: boolean },
 *     buttons?: Array<{ id: string, label: string, kind?: "primary"|"danger"|"default" }>,
 *     defaultButtonId?: string,
 *     cancelButtonId?: string,
 *     closeOnOverlay?: boolean,
 *     closeOnEsc?: boolean,
 *   }) => Promise<{ id: string, value: any }>,
 *   alert: (message: string, opts?: { title?: string, okText?: string }) => Promise<void>,
 *   confirm: (message: string, opts?: { title?: string, okText?: string, cancelText?: string, danger?: boolean }) => Promise<boolean>,
 *   prompt: (message: string, defaultValue?: string, opts?: { title?: string, okText?: string, cancelText?: string, placeholder?: string }) => Promise<(string|null)>,
 *   close: () => void,
 * }} AFUIDialog
 */

/**
 * @typedef {{
 *   init: () => void,
 *   dialog: AFUIDialog,
 *   setStatus: (text: string, kind?: "info"|"error"|"warn"|"success") => void,
 *   updateSelectionClasses: () => void,
 *   renderAllUIElements: () => void,
 *   renderProductionSummary: () => void,
 *   updateLayoutGridColumns: () => void,
 *   updateCreateBlueprintButton: () => void,
 * }} AFUI
 */

/**
 * @typedef {{ invalidate: (opts?: { needsRecalc?: boolean, needsRender?: boolean, forceRecreate?: boolean }) => void, flushNow: () => void }} AFScheduler
 */

/**
 * @typedef {{
 *   state: AppState,
 *   consts: AFConsts,
 *   core: AFCore,
 *   ui: AFUI,
 *   scheduler: AFScheduler,
 *   calculator: AFCalculator,
 *   render: AFRender,
 * }} AFNamespace
 */

/**
 * Public type alias used throughout the codebase via JSDoc `@type {AF}` annotations.
 * @typedef {AFNamespace} AF
 */