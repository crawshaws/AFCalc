# Alchemy Factory Planner - Project Documentation

## Project Overview


**IMPORTANT**
 - This is a static web page with css and js assets. NOT A NodeJS app and has no special requirements to run other than opening the html file
 - If you wish to run a command, I would like you to tell be PRIOR to running the command why you want to run it and the ask to run the command. Without this, I have no context to know if I should actually allow the running of your commands
 - If new data structures are created/updated or the application structure changes (namespaces etc), PLEASE ensure the types.app.js file is kept up to date ALWAYS.

**Alchemy Factory Planner** is a standalone, offline web application for planning and optimizing factory layouts in the game "Alchemy Factory." The application allows users to:
- Define a database of materials, machines, and recipes
- Design factory layouts on a visual canvas
- Calculate production flows and rates
- Apply skill point modifiers to optimize efficiency
- Import/export configurations as JSON

**Technology Stack:**
- Pure HTML, CSS, and JavaScript (no frameworks)
- Client-side only (no server required)
- LocalStorage for persistence
- Runs completely offline

---

## Core Data Model

### Materials
Each material represents an in-game resource with the following properties:

```javascript
{
  id: string,              // Unique identifier (e.g., "mat_abc123")
  name: string,            // Display name
  buyPrice: number | null, // Purchase price in coins (null if not purchasable)
  salePrice: number | null,// Selling price in coins (null if not sellable)
  isFuel: boolean,         // Can be used as fuel
  fuelValue: number | null // Heat value in Pyra (P) if isFuel is true
}
```

**Realized Cost Calculation:**
- The "realized cost" is the minimum of:
  - The material's `buyPrice` (if available)
  - The production cost from any recipe that produces it
- For recipes with multiple inputs, sum all input costs before dividing by output quantity
- Handles circular dependencies with detection and informative messages
- Uses memoization for performance optimization

### Machines
Each machine represents a production unit:

```javascript
{
  id: string,                    // Unique identifier
  name: string,                  // Display name
  kind: "standard" | "furnace",  // Machine type
  inputs: number,                // Number of input slots (0-N)
  outputs: number,               // Number of output slots (1-N)
  requiresFurnace: boolean,      // Must be placed on a furnace
  heatConsumptionP: number | null, // Heat consumption (Pyra/P per second)
  baseHeatConsumptionP: number | null // For furnaces: base heat consumption (typically 1P)
}
```

**Special Machine Types:**
- **Furnace**: Has `baseHeatConsumptionP` (typically 1P). Other machines can be placed on furnaces. Heat calculation: `baseHeat + sum(topper_heat_values)`
- **Storage**: Special canvas-only machine (not in database). Has 2 output ports at conveyor speed, infinite capacity.
- **Purchasing Portal**: Special canvas-only machine. Outputs one material at max belt speed, assumes infinite coins.

### Recipes
Each recipe defines a transformation process:

```javascript
{
  id: string,                  // Unique identifier
  name: string,                // Display name
  machineId: string,           // Associated machine ID
  processingTimeSec: number,   // Base processing time in seconds
  heatConsumptionP: number | null, // Optional heat override
  inputs: [                    // Array of input requirements
    {
      materialId: string,      // Material ID
      items: number            // Number of items (not rate)
    }
  ],
  outputs: [                   // Array of outputs
    {
      materialId: string,      // Material ID
      items: number            // Number of items (not rate)
    }
  ]
}
```

**Recipe Rules:**
- Inputs/outputs determined by machine's input/output count
- At least 1 input required (not all slots need to be filled for multi-input machines)
- Outputs must exactly match machine's output count
- Recipes are displayed under the material they produce (embedded in materials view)
- Processing time can be entered as seconds (e.g., "150") or time format (e.g., "2m30s", "1m", "45s")

### Build Canvas State
The canvas stores placed machines and connections:

```javascript
{
  placedMachines: [
    {
      id: string,                   // Unique placed machine instance ID
      type: "machine" | "storage" | "purchasing_portal",
      machineId: string | null,     // Reference to machine definition (null for storage/portal)
      recipeId: string | null,      // Selected recipe (null if not set)
      count: number,                // Number of machines (1-999)
      x: number,                    // X coordinate on canvas
      y: number,                    // Y coordinate on canvas
      
      // Storage-specific (type === "storage"):
      storage: [{ materialId: string, quantity: number }],
      
      // Purchasing Portal-specific (type === "purchasing_portal"):
      materialId: string | null     // Material to purchase
    }
  ],
  connections: [
    {
      fromMachineId: string,        // Source machine
      fromPortIdx: number,          // Output port index
      toMachineId: string,          // Target machine
      toPortIdx: number             // Input port index
    }
  ],
  selectedMachine: string | null,   // Currently selected machine ID
  dragConnection: object | null     // Connection being dragged
}
```

---

## Skill System

### Skill Definitions

| Skill ID | Name | Base Value | Bonus per Point | Formula |
|----------|------|------------|-----------------|---------|
| `conveyorSpeed` | Conveyor Speed | 60/min | +15/min | `60 + (15 × skill)` |
| `throwingSpeed` | Throwing Speed | 60/min | +15/min | `60 + (15 × skill)` |
| `machineEfficiency` | Machine Efficiency | 100% | -25% time | `baseTime × (1 - 0.25 × skill)` |
| `alchemyEfficiency` | Alchemy Efficiency | 100% | +3% output | `baseOutput × (1 + 0.03 × skill)` |
| `fuelEfficiency` | Fuel Efficiency | 100% | +10% heat value | `baseHeatValue × (1 + 0.10 × skill)` |
| `fertilizerEfficiency` | Fertilizer Efficiency | 100% | +10% value | `baseValue × (1 + 0.10 × skill)` |
| `shopProfit` | Shop Profit | 100% | +3% profit | `basePrice × (1 + 0.03 × skill)` |

### Skill Helper Functions

```javascript
// Conveyor & Throwing Speed
getConveyorSpeed()          // Returns: 60 + (15 × skill)
getThrowingSpeed()          // Returns: 60 + (15 × skill)

// Machine Efficiency (REDUCES processing time)
getFactoryEfficiency(baseTimeInSec)  
// Returns: baseTime × (1 - 0.25 × skill)
// Example: 10s with 1 point = 10 × 0.75 = 7.5s
// Capped at 95% reduction

// Fuel Heat Value (INCREASES heat value of fuels)
getFuelHeatValue(totalBaseP)
// Returns: totalBaseP × (1 + 0.10 × skill)

// Fertilizer Value (INCREASES fertilizer effectiveness)
getFertilizerValue(totalBaseV)
// Returns: totalBaseV × (1 + 0.10 × skill)

// Shop Profit (INCREASES profit from sales)
getProfit(basePriceC)
// Returns: basePriceC × (1 + 0.03 × skill)

// Alchemy Efficiency (INCREASES extractor output)
getAlchemyEfficiency(baseOutput)
// Returns: baseOutput × (1 + 0.03 × skill)
```

**Important Notes:**
- All calculations use these helper functions to ensure consistency
- Skills are stored separately in localStorage with key `af_planner_skills_v1`
- Machine efficiency REDUCES time (subtractive), not increases it
- Fuel efficiency INCREASES the heat value of fuels (makes fuel last longer)

---

## Calculation Rules

### Production Rate Calculation

**Base Formula:**
```
Rate (items/min) = (items / effectiveProcessingTime) × 60 × machineCount
```

Where:
- `items` = number of items from recipe
- `effectiveProcessingTime` = `getFactoryEfficiency(recipe.processingTimeSec)`
- `machineCount` = number of machines of this type (1-999)

**Example:**
- Recipe: 2 items in 10 seconds
- Machine count: 3
- Machine efficiency skill: 1 point (25% reduction)
- Effective time: `10 × 0.75 = 7.5s`
- Rate: `(2 / 7.5) × 60 × 3 = 48 items/min`

### Conveyor Connections

**Rules:**
- Conveyors transport materials at `getConveyorSpeed()` items/min
- Each connection is between one output port and one input port
- Multiple connections can originate from the same output port
- Each input port can only have ONE incoming connection
- Connections must be between compatible materials (output material matches input requirement)

### Purchasing Portal Rules

**Behavior:**
- Outputs at max belt speed: `getConveyorSpeed()` items/min
- Assumes infinite coin supply (no coin input required)
- Single output port
- Machines connected to purchasing portals should assume sufficient input to run at 100% capacity
- Any excess output from portal that isn't consumed is ignored (not an issue for planning)

### Storage Rules

**Behavior:**
- Infinite capacity
- 2 output ports, each at `getConveyorSpeed()` items/min
- No inputs (source machine)
- Used for manual material supply

### Net Production Calculation

For the entire factory:
```
netProduction[materialId] = totalOutput[materialId] - totalInput[materialId]
```

- Positive = surplus/production
- Negative = deficit/consumption
- Zero = balanced

**Source Machines:** Machines with no input connections (Storage, Purchasing Portal, or disconnected machines)

**Sink Machines:** Machines with no output connections (end of production line)

---

## UI Components

### Sidebar (Database Editor)

**Materials Tab:**
- Search bar and "Add" button
- Custom dropdown selector (replaces scrolling list)
- Material editor form:
  - Name, Fuel Value
  - Buy Price, Sale Price
  - Is Fuel checkbox
  - Realized Cost (calculated, read-only)
  - Delete button
- Embedded Recipe Cards:
  - Displayed under materials they produce
  - Collapsible cards with header/body
  - "Add Recipe" button per material
  - Recipe form embedded in card body

**Machines Tab:**
- Search bar and "Add" button
- Machine dropdown selector
- Machine editor form:
  - Name, Kind (standard/furnace)
  - Number of inputs/outputs
  - Requires Furnace checkbox
  - Heat consumption value
  - Furnace-specific: Base heat consumption
  - "Add to Canvas" button
  - Delete button

### Design Canvas

**Features:**
- Grid background (40px × 40px major, 10px × 10px minor)
- Drag-and-drop machine placement
- Conveyor connections (SVG lines between ports)
- Machine cards display:
  - Machine name
  - Machine count input (1-999)
  - Recipe selector dropdown
  - Input/output ports with rates
  - Delete button
- Right-click context menu:
  - Add Machine (blank card with machine selector)
  - Add Storage
  - Add Purchasing Portal
  - Add Export
- Header:
  - Title and conveyor speed display
  - "📊 Production Summary" button

**Machine Interaction:**
- Drag header to move machine (bounded to canvas)
- Click to select (blue border)
- Change machine count in header input
- Select recipe from dropdown
- Click output port → click input port to create connection
- Connections prevent if incompatible

### Dialogs

**Skills Dialog:**
- Opened via `Edit → Skill Points`
- Lists all 7 skills with descriptions
- Number input for each skill (0-10)
- Save button persists to localStorage

**Production Summary Dialog:**
- Opened via canvas header button
- Shows:
  - Source machines (no inputs)
  - Sink machines (no outputs)
  - Net production/consumption per material (color-coded)

---

## File Structure & Storage

### File System
```
/AF/
├── jsconfig.json        # Editor-only: enables cross-file IntelliSense for JSDoc types
├── index.html           # Main HTML structure
├── styles.css          # All styling
├── app/                 # Layered JS files (classic scripts, file:// safe)
│   ├── shared.app.js     # Shared helpers/utilities (no DOM writes)
│   ├── types.app.js      # JSDoc type hub for AF.* (IDE IntelliSense only)
│   ├── calculator.app.js # Calculation layer (machine tree + derived state)
│   ├── render.app.js     # Render-only layer (canvas/cards/connections DOM)
│   ├── ui.app.js         # UI wiring/actions + DOM-only helpers (dialogs, menus, etc.)
│   └── app.js            # Core/orchestrator (state + persistence + boot)
└── PROJECT_DOCUMENTATION.md  # This file
```

### Layered Architecture

The codebase is split into layers (in `/app`) while remaining compatible with offline `file://` usage (no ES modules, no bundler).

- **Core/orchestrator (`app/app.js`)**: owns `state`, persistence, and bootstrapping. Exposes a global namespace `window.AF`.
- **Calculator (`app/calculator.app.js`)**: performs all expensive/derived calculations and writes them into `state` (notably `state.calc` and per-machine efficiency fields).
- **Renderer (`app/render.app.js`)**: reads precomputed values from `state`/`state.calc` and updates the DOM; should not trigger recalculation.
- **UI (`app/ui.app.js`)**: event wiring and state mutations; DOM-only helpers live here (including the system dialog service).

**Scheduling model:** UI changes call `AF.scheduler.invalidate(...)` which coalesces work and runs in order:
1. `AF.calculator.recalculateAll()` (if dirty)
2. `AF.render.*` DOM updates (if dirty)

This ensures redraws don’t accidentally recompute, and enables future background/idle recalculation.

**Port-rate snapshot (enforcing calc-only computations):**

To prevent render/UI from calling calculation helpers directly (e.g. `getPortOutputRate`, `getPortInputDemand`), the calculator populates a precomputed snapshot:

- `state.calc.port.outputRate`: `Map` keyed by `${machineId}::${portIdx}` → max output rate (items/min at 100% operation)
- `state.calc.port.inputDemand`: `Map` keyed by `${machineId}::${portIdx}` → max input demand (items/min at 100% operation)
- `state.calc.port.outputMaterial`: `Map` keyed by `${machineId}::${portIdx}` → output material id (or `null`)
- `state.calc.port.inputMaterial`: `Map` keyed by `${machineId}::${portIdx}` → input material id (or `null`)

Renderer code should read from `state.calc.port.*` (plus machine `efficiency` / connection `actualRate`) and must not invoke calculation helpers.

### System Dialogs (No native browser dialogs)

The UI layer provides a theme-consistent dialog service at `AF.ui.dialog` which replaces native `alert()` / `confirm()` / `prompt()`:

- `AF.ui.dialog.alert(message, opts?)`
- `AF.ui.dialog.confirm(message, opts?)` → `Promise<boolean>`
- `AF.ui.dialog.prompt(message, defaultValue?, opts?)` → `Promise<string|null>`
- `AF.ui.dialog.open(opts)` → dialog builder for custom content/buttons

### Export Node (placeable sink)

For cyclical/self-fed layouts where a machine has real outgoing connections but still produces *surplus*, you can add an **Export** node on the canvas and connect surplus-producing outputs into it.

- The Export node is a **placeable infinite sink** (like the virtual sink used for unconnected outputs)
- It has a single **multi-material input** that accepts multiple incoming connections
- Any flow into Export is counted as **Exports** in the production summary (using the actual distributed connection rates)
- **Blueprints**: When creating a blueprint, connections that feed an Export node are treated as **blueprint outputs** (per material). Export nodes are kept inside the blueprint as virtual sinks, but they are not shown/count as machines in blueprint UI.

### LocalStorage Keys

| Key | Content | Format |
|-----|---------|--------|
| `af_planner_db_v1` | Materials, machines, recipes | JSON |
| `af_planner_build_v1` | Canvas state (placed machines, connections) | JSON |
| `af_planner_skills_v1` | Skill point allocations | JSON |

### Import/Export

**Export:**
- `File → Export JSON` downloads `af_planner_db_v1` as a JSON file
- Filename format: `alchemy-factory-db-{timestamp}.json`
- `File → Export Build (Canvas Only)` downloads a compact, importable JSON containing only the canvas build (placed machines, connections, camera)

**Import:**
- `File → Import JSON` loads database from JSON file
- Validates structure and migrates old data formats
- Does NOT import build canvas or skills (only database)

**Clear Functions:**
- `File → New (clear local data)` - Clears database only
- `File → Clear Build Canvas` - Clears only canvas (keeps database)

---

## Technical Implementation Details

### Data Normalization

The `normalizeDb` function ensures loaded data conforms to schema:
- Provides default values for missing fields
- Migrates old data formats (e.g., `ppm` → `items`)
- Ensures type consistency
- Handles schema version differences

### Time String Parsing

User-friendly time input supports:
- Seconds only: `"150"` → 150 seconds
- Minutes and seconds: `"2m30s"` → 150 seconds
- Minutes only: `"2m"` → 120 seconds
- Seconds only: `"45s"` → 45 seconds

### Coordinate System

**Canvas Coordinates:**
- Origin (0,0) is top-left of canvas element
- Coordinates are relative to canvas, not window
- Accounts for canvas scroll offset when calculating positions
- Drag bounds prevent machines from going off top/left edges:
  ```javascript
  pm.x = Math.max(0, newX);
  pm.y = Math.max(0, newY);
  ```

### Event System

**Event Delegation:**
- Centralized event listeners on `document` or `canvas`
- Uses `data-action` attributes for action routing
- Example: `data-action="material:delete"` → `handleAction("material:delete", data)`

**Action Types:**
- `file:*` - File operations (new, import, export, clear-build)
- `edit:*` - Edit operations (skills, undo, redo)
- `material:*` - Material operations (delete, add-recipe)
- `machine:*` - Machine operations (delete, add-to-canvas)
- `recipe:*` - Recipe operations (delete)
- `build:*` - Canvas operations (delete-machine)
- `canvas:*` - Canvas context menu (add-machine, add-storage, add-portal)
- `dialog:*` - Dialog operations (close)
- `skills:*` - Skills operations (save)

---

## Future Considerations

### Critical Architectural Improvements

**1. Blueprint Physical Instance Model** (See `BLUEPRINT_ARCHITECTURE_REDESIGN.md`)
   - **Problem:** Current blueprints are "black boxes" with pre-calculated rates that require special-casing in all calculations
   - **Solution:** When placing a blueprint, copy its contents as physical child machines in the instance
   - **Benefits:**
     - Calculations traverse naturally through the tree
     - Efficiency propagates automatically
     - Direct connection tracking through blueprints
     - No virtual machine creation needed
     - Simpler, more maintainable code
   - **Status:** Designed, ready for implementation

**2. Class-Based UI Architecture** (See `CLASS_BASED_UI_ARCHITECTURE.md`)
   - **Problem:** Current DOM generation is coarse-grained (whole card recreation on small changes)
   - **Solution:** Each machine card becomes a class instance that updates specific DOM nodes when properties change
   - **Benefits:**
     - 10x faster for incremental updates
     - Better encapsulation and maintainability
     - Easier to extend with new machine types
   - **Status:** Designed, not yet implemented

### Potential Enhancements
1. **Furnace System Integration:**
   - Calculate fuel consumption based on heat requirements
   - Track fuel burn times
   - Optimize furnace/topper configurations

2. **Advanced Production Analysis:**
   - Bottleneck detection
   - Resource efficiency scoring
   - Cost optimization suggestions

3. **Storage Configuration:**
   - UI to configure storage contents
   - Material quantity tracking
   - Storage capacity planning

4. **Enhanced Connections:**
   - Connection splitting (one output to multiple inputs)
   - Connection merging (multiple outputs to one input)
   - Conveyor overflow handling

5. **Blueprint Features:**
   - Detached editing (modify instance without affecting source)
   - Blueprint versioning
   - Nested blueprint optimization

---

## Code Architecture Principles

1. **No Frameworks:** Pure vanilla JavaScript for maximum portability and minimal dependencies
2. **Single Responsibility:** Functions do one thing well (calculate, render, persist, etc.)
3. **Centralized State:** All application state in single `state` object
4. **Helper Functions:** Skill calculations centralized in helper functions used throughout codebase
5. **HTML Templates:** Reusable HTML defined in `<template>` tags for better IDE support
6. **Memoization:** Expensive calculations (like realized cost) use caching to prevent re-calculation
7. **Progressive Enhancement:** Application works with basic features even if some data is missing

---

## Game-Specific Rules

### Heat System
- **Base Heat:** Furnace has base consumption (typically 1P per second)
- **Toppers:** Machines placed on furnaces add to heat consumption
  - Example: 1 Crucible = 4P, so Furnace + Crucible = 5P total
  - Multiple toppers: 3 Crucibles + Furnace = (4×3) + 1 = 13P
- **Fuel Burn Time:** `fuelHeatValue / totalHeatConsumption`
  - Fuel efficiency skill increases `fuelHeatValue`, making fuel last longer

### Material Flow
- Materials move at belt speed (conveyor or throwing speed)
- Machines consume inputs at rates determined by recipe and efficiency
- Excess materials can be stored or discarded
- Purchasing portals provide unlimited materials at belt speed (assumes coins available)

### Recipe Optimization
- Machine efficiency skill reduces processing time, increasing throughput
- Multiple machines of same type multiply output linearly
- Balancing input/output rates prevents bottlenecks

---

## Recent Bug Fixes

### Blueprint Efficiency Calculation and Display (2026-01-28)

**Issue 1: Virtual Sink Connections Not Created for Blueprint Outputs**

When a blueprint had no external output connections, child machines inside the blueprint that produced outputs were not receiving virtual sink connections. This caused:
- No demand signal from the virtual sink (which has infinite demand)
- All machines underclocking to near-zero efficiency
- Blueprint showing 0% or very low efficiency instead of 100%

**Root Cause:** The virtual sink connection logic only checked if a machine had outgoing connections. For child machines inside blueprints, they have internal connections (to other machines in the blueprint), so they appeared to have outputs even when the blueprint's external output port was unconnected.

**Fix:** Added special handling in the virtual sink connection creation (lines 4432-4491). For child machines inside blueprints, the code now checks if they're mapped to a blueprint output port that has no external connections. If so, a virtual sink connection is created for that specific port, providing the 100% demand signal needed.

**Issue 2: Blueprint Efficiency Calculation Including Source Machines**

Blueprint efficiency was calculated as the minimum of ALL child machines, including purchasing portals and other source machines. Source machines naturally scale to downstream demand (e.g., a purchasing portal at 1% efficiency just means it's supplying 1% of max output as needed), so including them in the minimum efficiency calculation was misleading.

**Fix:** Modified `calculateMachineEfficiencies()` (lines 4810-4828) to exclude source machine types (purchasing portals, fuel sources, nurseries, storage) when calculating the blueprint's displayed efficiency. The blueprint efficiency badge now only reflects production machines (machines with recipes), accurately representing the blueprint's bottleneck.

**Issue 3: Blueprint Card Rendering Recalculating Efficiency Incorrectly**

The blueprint card rendering code (lines 5686-5699) was recalculating efficiency from scratch instead of using the pre-calculated value from `calculateMachineEfficiencies()`. This recalculation included ALL child machines (including source machines), which resulted in displaying incorrect efficiency percentages even though the calculation was correct.

**Fix:** Changed the rendering code to use the pre-calculated `placedMachine.efficiency` value directly instead of recalculating it. This ensures the UI always displays the correctly calculated efficiency that excludes source machines.

**Issue 4: Purchasing Portals Showing Meaningless Efficiency Badges**

Purchasing portals (and other source machines) displayed efficiency badges showing how much downstream demand existed. This was confusing because source machine "efficiency" doesn't represent a bottleneck - it just indicates demand levels.

**Fix:** Removed efficiency badges and underclocking warnings from purchasing portal cards (lines 5848-5867). Source machines now never show efficiency indicators, as their scaling behavior is by design, not a performance issue.

---

*Document Version: 1.1*  
*Last Updated: 2026-01-29*  
*Project Status: Core features complete, ready for enhancement*

---

## Blueprint Sidebar Enhancements (2026-01-29)

In the **Blueprints** side panel, each blueprint entry now has extra action buttons:

- **Add items to canvas (＋)**: Adds the blueprint's internal machines/connections directly onto the main canvas as new, normal items (no blueprint container card is placed). Nested blueprint instances are expanded when possible using stored `portMappings`.
- **Edit as copy (✎)**: Opens the blueprint editor preloaded with that blueprint, but **Save** creates a new blueprint copy (the original blueprint is not modified).
