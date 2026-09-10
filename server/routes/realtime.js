import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequestBody } from '../lib/http.js';
import { enforceOptInRateLimit, makeOptInRateLimiter } from '../lib/ratelimit.js';
import {
  VOICE_MODELS,
  resolveVoiceModel,
  isKnownVoiceTier,
} from '../../src/voice/voiceCost.js';

/**
 * OpenAI Realtime voice: ephemeral-token minting and the debug-log sink.
 *
 * These two routes lived inside `vite.config.js`, which means they existed
 * ONLY under `npm run dev`. A production build (`node server/index.js`) served
 * `/api/realtime/token` through sirv's SPA fallback — the browser got
 * `index.html` with `Content-Type: text/html` instead of a token, so the voice
 * agent was silently dead in every deployed build. Moving them into the shared
 * `server/routes.js` manifest is what makes the agent survive production;
 * dev and prod now mount one implementation (docs/ARCH-SERVER-SPLIT.md §3).
 *
 * The session config — model tier, voice, reasoning effort, context budget,
 * instructions and the tool schema — is built here and handed to OpenAI's
 * `client_secrets` endpoint, so the browser never sees the API key.
 *
 * @module server/routes/realtime
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root, two levels up from server/routes/. */
const ROOT_DIR = path.resolve(__dirname, '..', '..');

const OPENAI_REALTIME_MODEL_DEFAULT = VOICE_MODELS.standard.id;
const OPENAI_REALTIME_MODEL_MINI_DEFAULT = VOICE_MODELS.mini.id;
const OPENAI_REALTIME_VOICE_DEFAULT = 'marin';
const OPENAI_REALTIME_REASONING_DEFAULT = 'low';
const OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT = 3000;
const OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT = 0.5;
const REALTIME_DEBUG_LOG_DIR = path.join(ROOT_DIR, '.gev-logs');
const REALTIME_DEBUG_LOG_FILE = path.join(REALTIME_DEBUG_LOG_DIR, 'realtime-conversations.jsonl');
const REALTIME_DEBUG_LOG_MAX_BYTES = 8 * 1024 * 1024;

const GEV_REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'fly_to_location',
    description: "Fly the God's Eye View camera to a known city, geocoded country/region/city/landmark, or explicit WGS84 coordinate. Countries/cities frame the whole place; landmarks/buildings use close framing.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: {
          type: 'string',
          enum: ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'],
          description: 'Known city preset ID. Use when the requested place matches one of these cities.',
        },
        query: {
          type: 'string',
          description: 'Plain place search query, e.g. "London", "Eiffel Tower", or "Dubai Marina".',
        },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        viewMode: {
          type: 'string',
          enum: ['close', 'overview'],
          description: 'Optional framing intent. Usually omit this; GEV infers whole-place framing for countries/cities and close framing for landmarks.',
        },
        rangeM: {
          type: 'number',
          minimum: 100,
          maximum: 20000000,
          description: 'Optional camera range from the target in meters. Omit it for automatic whole-country/whole-city or close-landmark framing; provide it only when the user explicitly requests a numeric height or distance.',
        },
        waitForArrival: {
          type: 'boolean',
          description: 'Set true when a later tool depends on the destination viewport. The result then waits for the camera flight and returns arrived=true; cancellation returns ok=false.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'select_nearest_aircraft',
    description: 'Atomically fly to a place, wait for arrival, enable and load Flights or Military Flights in that viewport, exclude on-ground records, and select/follow the nearest airborne aircraft. Healthy fallback feeds remain usable and are reported in the result. This does not open Contacts or Cockpit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: ['flights', 'military'],
          description: 'Aircraft layer to enable and search. Use flights unless the user explicitly asks for military aircraft.',
        },
        locationId: {
          type: 'string',
          enum: ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'],
          description: 'Known city preset ID when the place matches one of these cities.',
        },
        locationQuery: {
          type: 'string',
          maxLength: 160,
          description: 'Free-form destination when no locationId matches.',
        },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
      },
      required: ['layerId'],
    },
  },
  {
    type: 'function',
    name: 'adjust_camera_zoom',
    description: 'Move the current Cesium camera closer to or farther from what it is presently looking at. Use for relative zoom requests without changing location.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        direction: {
          type: 'string',
          enum: ['in', 'out'],
        },
        amount: {
          type: 'string',
          enum: ['little', 'medium', 'lot'],
          description: 'Use little for phrases like "a bit" or "a little", medium for ordinary zoom requests, and lot for "way out/in".',
        },
      },
      required: ['direction', 'amount'],
    },
  },
  {
    type: 'function',
    name: 'zoom_to_globe',
    description: 'Pull the camera out to an ABSOLUTE full-Earth globe view (~18,000 km altitude, the whole planet in frame), keeping the current region centered. Use for "globe view", "whole earth", "see the planet", "zoom all the way out". Never use adjust_camera_zoom for these — its relative steps cannot reach the globe.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'set_layer_visibility',
    description: "Enable or disable one registered God's Eye View data layer.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          description:
            'Common-name mapping for the non-obvious ids: space mission(s) → rocket-launches; fires/wildfires/active fires → local-firms (NASA FIRMS); ships/vessels/boats → ais-live-vessels; undersea/submarine cables → telegeography-submarine-cables; datacenters → local-datacenters; dams → local-dams; bikes/bike share → bikeshare; street traffic/congestion → traffic; traffic cameras → cctv; internet radio/stations → radio.',
          enum: [
            'flights',
            'military',
            'earthquakes',
            'satellites',
            'rocket-launches',
            'traffic',
            'cctv',
            'radio',
            'bikeshare',
            'ais-live-vessels',
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
            'weather-radar',
          ],
        },
        enabled: { type: 'boolean' },
      },
      required: ['layerId', 'enabled'],
    },
  },
  {
    type: 'function',
    name: 'control_weather_radar',
    description:
      "Play, pause or scrub the weather-radar rain loop — \"play the rain\", \"pause it\", \"show me an hour ago\", \"what's the latest frame?\". Only affects the radar animation; use set_layer_visibility{layerId:'weather-radar'} to turn the layer on or off first. Frames are roughly 10 minutes apart, newest last.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'pause', 'step', 'latest', 'oldest', 'status'],
          description:
            "'step' moves by `frames` (negative = back in time); 'latest' jumps to the newest frame, 'oldest' to the start of the loop.",
        },
        frames: {
          type: 'number',
          description:
            "Frames to move for 'step'. Negative goes back in time. One frame is about 10 minutes.",
        },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'share_view',
    description:
      'Produce a shareable link that reproduces the CURRENT view — camera, visual style, active layers, and a tracked target if there is one. Use for "share this", "send me this view", "give me a link". Returns the URL so it can be read back or shown; also copies it to the clipboard when the browser permits.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        copyToClipboard: {
          type: 'boolean',
          description: 'Attempt a clipboard copy as well as returning the URL. Defaults to true.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'manage_alerts',
    description:
      'Arm, inspect, or clear standing watches on live data. Use this whenever the user asks to be TOLD or NOTIFIED about something in the future rather than shown it now — "let me know if a helicopter comes within 20km", "watch for emergency squawks", "alert me about big earthquakes", "what has triggered?". A rule keeps evaluating in the background after the conversation moves on. For a one-off look at what is on screen right now, use analyst_query instead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'enable', 'disable', 'delete', 'feed'],
          description: "'feed' reports what has already fired; 'list' reports the armed rules.",
        },
        name: { type: 'string', description: 'Short human label for a created rule.' },
        layer: {
          type: 'string',
          enum: ['flights', 'military', 'earthquakes', 'ais-live-vessels', 'local-firms'],
          description: 'Which live feed the rule watches. Defaults to flights.',
        },
        conditions: {
          type: 'array',
          description:
            'Conditions, ALL of which must hold. Common fields by layer — flights/military: altitude (metres), velocity (m/s), squawk, callsign, category; earthquakes: magnitude, depth; ais-live-vessels: speed, type; local-firms: brightness, frp.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: { type: 'string' },
              op: {
                type: 'string',
                enum: ['lt', 'lte', 'gt', 'gte', 'eq', 'neq', 'in', 'contains'],
              },
              value: {
                type: ['string', 'number', 'array'],
                items: { type: ['string', 'number'] },
                description: "Use an array only with op 'in'.",
              },
            },
            required: ['field', 'op', 'value'],
          },
        },
        radiusKm: {
          type: 'number',
          description:
            'Optional geofence radius around the CURRENT camera centre, snapshotted when the rule is created. Use when the user says "near here"/"within N km".',
        },
        severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
        ruleId: { type: 'string', description: "Target rule for 'enable', 'disable' and 'delete'." },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'show_data_layers_menu',
    description: 'Open the data layers dropdown/menu and optionally scroll to a specific layer row without toggling it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: [
            'flights',
            'military',
            'earthquakes',
            'satellites',
            'traffic',
            'cctv',
            'radio',
            'bikeshare',
            'ais-live-vessels',
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
          description: 'Optional layer row to scroll into view and highlight.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'set_panel_open',
    description: 'Open or close a GEV UI panel/dropdown.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        panelId: {
          type: 'string',
          enum: ['data-panel', 'location-bar', 'control-panel', 'cctv-panel', 'radio-panel', 'scene-panel', 'pp-toggles', 'global-context-panel'],
        },
        open: { type: 'boolean' },
      },
      required: ['panelId', 'open'],
    },
  },
  {
    type: 'function',
    name: 'set_context_mode',
    description: 'Enter or exit the Global Context sub-mode used by Contacts and Space Missions. Use Contacts only when the user explicitly requests Contacts, and Space Missions only when explicitly requested. A request to open the parent Context panel alone uses set_panel_open and must not activate either sub-mode. Selecting an aircraft does not imply Context.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['off', 'contacts', 'flights', 'space-missions', 'missions'],
          description: 'Use off to exit context mode.',
        },
      },
      required: ['mode'],
    },
  },
  {
    type: 'function',
    name: 'control_cockpit',
    description: 'Read or control Cockpit when the user explicitly requests Cockpit: establish Contacts and enter from a selected or tracked aircraft; exit; or navigate nearby Contacts with optional filters. Selecting or viewing an aircraft alone must not enter Cockpit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['enter', 'exit', 'previous', 'next', 'prev', 'status'],
          description: 'previous/next (or prev) navigates through nearby contacts in Cockpit context.',
        },
        targetLayer: {
          type: 'string',
          enum: ['flights', 'military', 'ais-live-vessels', 'military-installations'],
          description: 'Optional contact layer filter for next/previous (for example military for a military-only cycle).',
        },
        aircraftClass: {
          type: 'string',
          description: 'Optional aircraft class filter (for example helicopter) when using next/previous navigation.',
        },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'set_visual_style',
    description: "Set the active God's Eye View visual filter/style.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        style: {
          type: 'string',
          enum: ['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow'],
        },
      },
      required: ['style'],
    },
  },
  {
    type: 'function',
    name: 'get_entity_context',
    description: 'Get current GEV scene context, including basemap/3D-tile target context, selected entity metadata if active, and entities currently visible in the camera view.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: ['auto', 'selected', 'in_view'],
          description: 'Use auto by default. selected returns the clicked/selected entity; in_view returns visible entities near the screen center.',
        },
        layerId: {
          type: 'string',
          enum: [
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
          description: 'Optional layer filter for visible entity context.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 12,
        },
      },
    },
  },
  {
    type: 'function',
    name: 'get_current_view_state',
    description: 'Read the current camera, style, Context, Cockpit, HUD, detection, map stack, post-processing, scene-playback, tracked-entity, and layer state before choosing another action.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'set_hud',
    description: 'Control the intelligence HUD overlay: visibility and/or layout variant.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        visible: { type: 'string', enum: ['on', 'off', 'auto'], description: 'auto restores style-driven show/hide.' },
        layout: { type: 'string', enum: ['tactical', 'operator', 'minimal'] },
      },
    },
  },
  {
    type: 'function',
    name: 'set_detection',
    description: 'Control the detection overlay: on/off, density-derived Sparse/Balanced/Dense profile, and Elastic/Weighted layer allocation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: 'false turns detection OFF; true restores the current density-derived profile.' },
        mode: { type: 'string', enum: ['sparse', 'balanced', 'dense'] },
        densityPct: { type: 'number', description: 'Density snaps to 0, 25, 50, 75, or 100 and derives the active profile.' },
        allocationStrategy: { type: 'string', enum: ['elastic', 'weighted'], description: 'Elastic splits evenly then lends unused slots; Weighted follows demand and semantic weight.' },
      },
    },
  },
  {
    type: 'function',
    name: 'set_map_stack',
    description: 'Switch the basemap/imagery stack (NOT the satellites data layer and NOT a visual style filter).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stack: {
          type: 'string',
          enum: ['photoreal', 'bing-aerial', 'bing-labels', 'esri-imagery', 'osm'],
          description: 'photoreal = Google 3D. Use bing-aerial only when the user explicitly says "Bing aerial" — "satellite(s)" never means a basemap; only the explicit phrase "Esri" / "Esri imagery" means esri-imagery.',
        },
      },
      required: ['stack'],
    },
  },
  {
    type: 'function',
    name: 'set_post_processing',
    description: 'Control bloom and sharpen post-processing toggles and intensities.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bloom: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            intensityPct: { type: 'number', description: '0-200 (UI percent).' },
          },
        },
        sharpen: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            intensityPct: { type: 'number', description: '0-100 (UI percent).' },
          },
        },
      },
    },
  },
  {
    type: 'function',
    name: 'control_scene',
    description: 'Cinematic scene playback: list scenes, play one scene by name, stop, advance, or read status. Play starts a single named scene and returns immediately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'play', 'stop', 'next', 'status'] },
        sceneId: { type: 'string', description: 'Scene id or (partial) title for play.' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'control_cctv',
    description: 'CCTV camera operations: enable/disable the layer, select a camera by name, next/prev/nearest/focus, toggle coverage wedges / projection overlay / auto-hop, "viewshed" for color-coded per-camera coverage volumes, and "adjust" for the on-camera calibration gizmo.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['enable', 'disable', 'select', 'next', 'prev', 'nearest', 'focus', 'coverage', 'viewshed', 'adjust', 'projection', 'autohop'] },
        cameraQuery: { type: 'string', description: 'Camera name or id for select.' },
        enabled: { type: 'boolean', description: 'Explicit on/off for coverage/viewshed/adjust/projection/autohop; omit to toggle.' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'control_radio',
    description: 'Control Internet Radio playback without moving the map. Use select whenever the request includes a station category, name, country, coordinates, or nearby place—even when the user says play. Use play only for an unqualified "turn on/start the radio" request so the current or nearest station begins. Enable only reveals the Radio layer/markers without audio. Also supports disable, resume, pause, stop, next/previous, volume, and status.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['enable', 'disable', 'play', 'resume', 'pause', 'stop', 'next', 'previous', 'volume', 'select', 'status'],
          description: 'Use select for any request qualified by category, station, country, coordinates, or place. Use play only for an unqualified turn on/start/listen request. Use enable only when the user explicitly asks to show or enable the Radio layer or its markers without requesting audio.',
        },
        volumePct: { type: 'number', minimum: 0, maximum: 100, description: 'Required for volume; sets the persistent Radio playback volume.' },
        category: {
          type: 'string',
          enum: ['all', 'news', 'talk', 'weather', 'public-safety', 'aviation-marine', 'traffic-transit', 'music'],
          description: 'Station category for select/next/previous. When the user requests playback with a category, action must be select, not play.',
        },
        locationId: {
          type: 'string',
          enum: ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'],
          description: 'Known nearby-city anchor for select.',
        },
        locationQuery: { type: 'string', maxLength: 120, description: 'Place to search near, such as "Austin, Texas" or "Seattle". Selection does not fly the camera.' },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        country: { type: 'string', maxLength: 80, description: 'Country code or name filter, for example US or United States.' },
        stationQuery: { type: 'string', maxLength: 120, description: 'Optional station name/tag substring.' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'track_entity',
    description: 'Find and follow a specific aircraft (callsign/ICAO hex), ship (name/MMSI), or satellite (name/NORAD id) on enabled layers. Camera follows the entity.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Callsign, ship name, satellite name, ICAO hex, MMSI, or NORAD id.' },
        layerId: { type: 'string', description: 'Optional layer hint: flights | military | ais-live-vessels | satellites.' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'stop_tracking',
    description: 'Stop following the tracked aircraft/satellite and clear any selected vessel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'frame_overhead',
    description: 'Cinematically frame entities near the current view: pulls the camera back and angles it so nearby aircraft, ships, or satellites are visible together.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', enum: ['flights', 'military', 'satellites', 'vessels'] },
        radiusKm: { type: 'number', description: 'Search radius around the view target. Defaults: 150 aircraft, 120 ships, 3000 satellites.' },
      },
      required: ['target'],
    },
  },
  {
    type: 'function',
    name: 'annotate_map',
    description: "Draw annotations on the 3D map to visually point out what you are talking about — like sketching on a whiteboard over the world. Use this whenever you mention a specific place, building, campus, boundary, district, or a relationship between two places, so the user can SEE what you mean. Give place NAMES (preferred) or explicit lat/lng; the app resolves them to real-world positions and real building/area outlines — never guess pixel positions. Call this as you begin describing something, and you may mark several places in one call.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        annotations: {
          type: 'array',
          description: 'One or more things to mark. Mark multiple related places together when describing them as a group.',
          minItems: 1,
          maxItems: 24,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: {
                type: 'string',
                enum: ['pin', 'highlight', 'area', 'arrow', 'route', 'label'],
                description: 'pin = planted marker at a spot; highlight = pulsing ring drawing the eye to a point; area = trace the outline of a building/campus/compound/district; arrow = a connector from one place to another (use target as the origin and toTarget as the destination); route = a path through several waypoints (use the points array); label = a floating text callout.',
              },
              target: { type: 'string', maxLength: 200, description: 'Place name to resolve, e.g. "Palace of Fine Arts, San Francisco", "the Pentagon", "Presidio of San Francisco". Preferred over coordinates. For a specific monument/statue/feature that sits within a larger landmark, use its OWN name + city ("Tejano Monument, Austin", "Texas African American History Memorial, Austin") — do NOT phrase it as "X at the Texas State Capitol", which makes the geocoder collapse several of them onto the same centroid so they stack on one spot.' },
              points: {
                type: 'array',
                description: 'For type=route: 2+ ordered waypoints the path passes through, each a place name (or coordinates / screen point).',
                minItems: 2,
                maxItems: 12,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    target: { type: 'string', maxLength: 200, description: 'Waypoint place name.' },
                    latitude: { type: 'number', minimum: -90, maximum: 90 },
                    longitude: { type: 'number', minimum: -180, maximum: 180 },
                    screenX: { type: 'number', minimum: 0, maximum: 1 },
                    screenY: { type: 'number', minimum: 0, maximum: 1 },
                  },
                },
              },
              mode: {
                type: 'string',
                enum: ['walking', 'driving', 'cycling'],
                description: 'For type=route: travel mode for a real street-following route (the app returns distance + time). Pick from the verb the user used ("walk" → walking, "drive" → driving). Defaults to walking.',
              },
              latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Explicit latitude (use only if no good place name exists).' },
              longitude: { type: 'number', minimum: -180, maximum: 180 },
              toTarget: { type: 'string', maxLength: 200, description: 'For type=arrow: the destination place name.' },
              toLatitude: { type: 'number', minimum: -90, maximum: 90 },
              toLongitude: { type: 'number', minimum: -180, maximum: 180 },
              label: { type: 'string', maxLength: 120, description: 'Short caption shown on the map (a few words). Optional.' },
              color: {
                type: 'string',
                enum: ['primary', 'amber', 'cyan', 'green', 'red'],
                description: 'Accent color. primary = neutral, amber = point of interest, cyan = infrastructure, green = confirmed/safe, red = alert.',
              },
              footprint: { type: 'boolean', description: 'For type=area/highlight: trace the real building or campus outline from map data. Defaults true for area.' },
              intent: { type: 'string', enum: ['the_thing', 'around_the_thing'], description: 'For type=area: "the_thing" (default) outlines the place itself (its footprint/boundary); "around_the_thing" highlights a surrounding zone (a buffered radius around it). Infer from phrasing: "the Capitol"/"show me X" → the_thing; "around/near/by X" or "the area around X" → around_the_thing.' },
              entityKind: { type: 'string', enum: ['building', 'compound', 'district', 'street', 'point_feature'], description: 'What KIND of thing the target IS — a fact, not a style choice: building = one structure; compound = campus/grounds/mall/park; district = neighborhood or area of a city; street = a named road/corridor; point_feature = monument/statue/memorial/plaque/fountain or other small point landmark. Set it whenever you know it — it routes the resolver to the right footprint source (point_feature anchors monuments as precise points instead of adopting a nearby building outline).' },
              screenX: { type: 'number', minimum: 0, maximum: 1, description: 'Fallback only: when you cannot name/geocode the place but can SEE it in the latest viewport screenshot, the normalized horizontal position (0=left, 1=right) of the spot. The app converts it back to a real world point under that pixel.' },
              screenY: { type: 'number', minimum: 0, maximum: 1, description: 'Fallback only: normalized vertical position (0=top, 1=bottom) of the spot in the latest viewport screenshot.' },
              toScreenX: { type: 'number', minimum: 0, maximum: 1, description: 'For type=arrow: normalized x of the arrow destination from the screenshot (pixel fallback).' },
              toScreenY: { type: 'number', minimum: 0, maximum: 1, description: 'For type=arrow: normalized y of the arrow destination from the screenshot (pixel fallback).' },
            },
            required: ['type'],
          },
        },
        flyTo: { type: 'boolean', description: 'Also move the camera to frame the first annotation. Default false — leave false if the user is already looking at the spot.' },
        persist: { type: 'boolean', description: 'Keep annotations until cleared (true, default) or let them auto-fade after ~20s (false).' },
      },
      required: ['annotations'],
    },
  },
  {
    type: 'function',
    name: 'clear_annotations',
    description: 'Erase ALL map annotations previously drawn with annotate_map. Call this ONLY when the user EXPLICITLY asks to clear or reset the map. Annotations accumulate and persist across navigation and topic changes by design — never clear on your own initiative.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'move_camera',
    description: 'Direct the camera like a drone operator: orbit the current view target, pan, tilt, or rotate — one bounded nudge (mode=once) or continuous motion until stopped (mode=continuous). Continuous motion also stops on any manual camera input or when a navigation tool runs. Say the RESULTING state when confirming ("Orbiting slowly").',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        motion: { type: 'string', enum: ['orbit', 'pan', 'tilt', 'rotate', 'stop'] },
        direction: { type: 'string', enum: ['left', 'right', 'up', 'down'], description: 'Required except for orbit (defaults right/clockwise) and stop.' },
        speed: { type: 'string', enum: ['slow', 'normal', 'fast'] },
        mode: { type: 'string', enum: ['once', 'continuous'], description: 'once = bounded eased nudge (default); continuous = until stop/manual input.' },
      },
      required: ['motion'],
    },
  },
  {
    type: 'function',
    name: 'fly_route',
    description: 'Cinematic dolly along an EXISTING route annotation (drawn earlier with annotate_map type=route) — flies the street-following path from start to end. Omit label for the newest route. If no route is drawn, this fails with guidance: draw the route first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: 'Match an existing route mark by (partial) label.' },
        speed: { type: 'string', enum: ['slow', 'normal', 'fast'] },
      },
    },
  },
  {
    type: 'function',
    name: 'analyst_query',
    description: 'Answer questions ABOUT the data currently loaded on the map — counts, lists, superlatives, and attribute filters over live layers (flights, military, ships, fires, earthquakes). Examples: "how many flights over Texas", "biggest fire near LA", "which ships are headed to Oakland", "anything above 40,000 feet", "fastest thing in view". Queries ONLY client-side data from ENABLED layers — if the needed layer is off, say so and offer to enable it. For a follow-up about the previous answer\'s set ("which of those is closest?"), set followUp=true and send only the new filters/sort.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layers: {
          type: 'array',
          items: { type: 'string', enum: ['flights', 'military', 'ais-live-vessels', 'local-firms', 'earthquakes'] },
          description: 'Layers to query. fires/wildfires → local-firms; ships/vessels → ais-live-vessels.',
        },
        scope: {
          type: 'object',
          additionalProperties: false,
          description: 'Spatial scope. Default: view (near the camera). Use kind=region for "over Texas"-style asks; kind=anywhere for global questions.',
          properties: {
            kind: { type: 'string', enum: ['view', 'region', 'radius', 'anywhere'] },
            name: { type: 'string', description: 'For kind=region: a state/country ("Texas", "France") or a named natural region ("the Alps", "Gulf of Mexico").' },
            km: { type: 'number', description: 'For kind=radius.' },
            center: { type: 'object', additionalProperties: false, properties: { lat: { type: 'number' }, lon: { type: 'number' } } },
          },
        },
        filters: {
          type: 'array',
          description: 'Attribute predicates, ANDed. ALTITUDE IS METERS (40,000 ft = 12192). Fields: altitudeM, speedMps, military, onGround, aircraftClass, callsign, operator, routeOrigin, routeDestination, originCountry (flights); speedKts, shipType, destination (ships); frp, confidence (fires); magnitude, depthKm, place (earthquakes).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: { type: 'string' },
              op: { type: 'string', enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains'] },
              value: {},
            },
            required: ['field', 'op', 'value'],
          },
        },
        sortBy: { type: 'string', description: 'Field to rank by, or "distance" for nearest-first.' },
        sortDir: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'number' },
        followUp: { type: 'boolean', description: 'true = re-query the PREVIOUS result set instead of fresh data.' },
      },
    },
  },
  {
    type: 'function',
    name: 'next_iss_pass',
    description: "When the user asks when the ISS / the space station will next fly over: returns the next visible ISS pass for the current camera location (or an explicit lat/lon) — rise time (ISO + minutes from now), rise compass direction, peak elevation, and duration. Requires the satellites layer to have loaded its catalog at least once this session; if it hasn't, tell the user to enable the satellites layer and try again.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Optional observer latitude. Omit to use the current camera position.' },
        longitude: { type: 'number', minimum: -180, maximum: 180, description: 'Optional observer longitude. Omit to use the current camera position.' },
        minElevationDeg: { type: 'number', minimum: 5, maximum: 60, description: 'Minimum peak elevation (deg) to count as a pass. Default 10.' },
      },
    },
  },
];

/**
 * Ephemeral Realtime token minted server-side, so `OPENAI_API_KEY` never
 * reaches the browser. Mounted at `/api/realtime/token`.
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 */
export function createRealtimeTokenRoute() {
  // Lazy singleton so the per-IP window state survives across requests — same
  // shape as server/routes/hudSummary.js's limiter.
  let _rateLimiter; // undefined = not built; null = unlimited; fn = active
  function rateLimiter() {
    if (_rateLimiter === undefined) _rateLimiter = makeOptInRateLimiter(process.env.GEV_RATELIMIT_OPENAI_PER_MIN);
    return _rateLimiter;
  }

  return async function realtimeTokenRoute(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). No-op when unset.
  if (!enforceOptInRateLimit(rateLimiter(), req, res)) return;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'OPENAI_API_KEY is not set' }));
    return;
  }

  // Voice model tier, requested by the client as ?tier=standard|mini.
  // resolveVoiceModel is total: an unknown, empty, or hostile value
  // resolves to `standard` instead of reaching OpenAI as a model id, so a
  // bad querystring degrades to a normal session rather than a dead mic.
  // The env overrides stay authoritative per tier (see .env.example) —
  // a wrong upstream model id is then a config fix, not a code change.
  const requestedTier = (() => {
    try {
      return new URL(req.url || '', 'http://localhost').searchParams.get('tier');
    } catch {
      return null;
    }
  })();
  const tier = resolveVoiceModel(requestedTier).tier;
  const model =
    tier === 'mini'
      ? process.env.OPENAI_REALTIME_MODEL_MINI || OPENAI_REALTIME_MODEL_MINI_DEFAULT
      : process.env.OPENAI_REALTIME_MODEL || OPENAI_REALTIME_MODEL_DEFAULT;
  const voice = process.env.OPENAI_REALTIME_VOICE || OPENAI_REALTIME_VOICE_DEFAULT;
  const effort = process.env.OPENAI_REALTIME_REASONING_EFFORT || OPENAI_REALTIME_REASONING_DEFAULT;
  const contextTokenLimit = Math.round(Math.max(
    1000,
    Math.min(12000, Number(process.env.OPENAI_REALTIME_CONTEXT_TOKENS) || OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT)
  ));
  const contextRetentionRatio = Math.max(
    0.1,
    Math.min(1, Number(process.env.OPENAI_REALTIME_CONTEXT_RETENTION) || OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT)
  );
  const sessionConfig = {
    session: {
      type: 'realtime',
      model,
      reasoning: { effort },
      truncation: {
        type: 'retention_ratio',
        retention_ratio: contextRetentionRatio,
        token_limits: {
          post_instructions: contextTokenLimit,
        },
      },
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          turn_detection: {
            type: 'semantic_vad',
            eagerness: 'low',
            create_response: true,
            interrupt_response: false,
          },
        },
        output: { voice },
      },
      instructions: [
        "You are GEV Voice Control, a concise voice controller for a Cesium geospatial app called God's Eye View.",
        'Have a natural spoken conversation with the user while the mic session is active.',
        'Do not require a wake phrase. Treat direct commands like "zoom into London" or "open datacenters" as GEV control requests.',
        'Only control the app by calling the provided tools. Never invent tool names or arguments.',
        'Call tools only for clear GEV control, navigation, visual-style, layer, or app-state requests. For ordinary conversation, answer normally without tools.',
        'For requests to open, show, reveal, or focus a menu/panel, call set_panel_open or show_data_layers_menu. "Open Context" means only set_panel_open{panelId:"global-context-panel",open:true}; it does not activate a Context sub-mode. "Open Contacts" means set_context_mode{mode:"contacts"}; that action expands the parent Context panel before activating Contacts.',
        'For requests like "show me the datacenter layers", open the data layers menu and focus the matching layer row; do not enable the layer unless the user asks to turn it on.',
        'For questions like "what am I looking at?", "what is in view?", "what is this?", "that selected thing", nearby datacenter, dam, cable, ship, or current view contents, call get_entity_context first, then answer from the returned scene/entity context.',
        'For "what is this aircraft?" answers, read the callsign, operator, registration, type, and route only from get_entity_context selected.properties. Treat route, routeOrigin, and routeDestination as the only authoritative route fields. Every aircraft identity answer MUST explicitly cover operator, type, and route. When a route is present, repeat its endpoint codes exactly; do not expand airport codes into city names. For a missing field say exactly "Operator details are unavailable", "Aircraft type is unavailable", or "Route details are unavailable" as applicable. Never silently omit missing enrichment or infer it from the callsign.',
        'While a camera motion or route flight is active, a bare "stop" means move_camera{motion:stop} — NOT control_scene and NOT stop_tracking (those need explicit words like "stop the scene" / "stop tracking"). If move_camera stop returns stopped:false and an entity is being tracked, call stop_tracking next — the user means "stop whatever is moving". Flying somewhere while tracking automatically stops the tracking (the result says so): mention it briefly.',
        'For camera-motion requests — "orbit around this", "pan left", "tilt up", "stop moving" — call move_camera. For "fly the route" over a drawn route, call fly_route. Confirm with the RESULTING state ("Orbiting slowly", "Flying the route").',
        'analyst_query ANSWERS questions; it never moves the camera or starts tracking. For requests to FOLLOW or TRACK a specific aircraft/ship, call track_entity (get_entity_context first when the target is ambiguous), never analyst_query as the final or only action. For "follow/track the nearest aircraft", first call analyst_query with the aircraft layer(s), sortBy=distance, and limit=1, then call track_entity with the returned aircraft identity in the same turn. The lookup alone does not fulfill a follow/track command.',
        'For a request to enable an aircraft layer and SELECT or FIND the nearest/closest aircraft near a named place — for example, "Turn on flights and select the closest aircraft to Austin" — call select_nearest_aircraft once. It atomically turns on the requested aircraft layer first, waits for location arrival, refreshes that layer for the destination viewport, filters out landed/on-ground records, and selects the nearest airborne result. A healthy fallback feed is valid data: report the returned feed source briefly, never call it an enable failure. Do not also call fly_to_location, set_layer_visibility, analyst_query, track_entity, set_context_mode, or control_cockpit for the same request. SELECT/FIND never implies Contacts or Cockpit unless the user explicitly asks for either mode.',
        'For ANALYTICAL questions about layer data — how many / which / fastest / highest / biggest / nearest flights, ships, fires, or earthquakes ("how many flights over Texas", "biggest fire near LA", "which ships are headed to Oakland", "anything above 40,000 feet") — call analyst_query, not get_entity_context. Narrate the count plus two or three notable examples by name, and reflect the result\'s coverage note honestly: the answer covers data loaded by enabled layers, not the whole world. If the needed layer is disabled, say so and offer to enable it. For follow-ups about the same set ("which of THOSE is closest?"), call analyst_query with followUp=true and only the new filter/sort.',
        'COUNTING CONTRACT — what "near" means. (1) While Contacts is ACTIVE, "near / nearby / how many aircraft" means the Contacts window: answer from contactsWindow in the tool result — those are the exact numbers on the user\'s panel. set_context_mode, analyst_query, and get_current_view_state carry it after Contacts settles. For "Open Contacts and tell me how many aircraft are within 250 km", call set_context_mode{mode:"contacts"} first and answer from contactsWindow.aircraft; do not answer from a pre-Contacts analyst query. analyst_query\'s own count measures currently-loaded records and is usually lower; never give it as the window count. CENTER PRECEDENCE for a nearby/how-many ask, in order: an explicit place in the question ("over Texas", "near Austin") always wins and ignores Contacts state; else the CONTACTS SUBJECT when Contacts is active and has one — a selected datacenter, dam, fire, or cable does NOT silently become the center; else an entity the user explicitly names ("around this datacenter"); else the current view, said aloud ("nothing is selected, so this is the current view"). With Contacts active but NO subject yet, use the view and say so; never read an empty panel. (2) With Contacts OFF, "nearby" means in view; "near <place>" means a radius around that place. (3) EVERY count names its scope in words — "42 in your window", "8 in view", "about 30 within 250 km of Austin" — never a bare number; analyst_query returns scopeLabel for exactly this. Two different numbers with named scopes are not a contradiction; say both if asked. (4) State counts VERBATIM — never estimate, round, or hedge ("a few", "less than a dozen"): if a tool returns 46, say 46. (5) When it matters, add once: counts cover loaded data, and the flights layer loads where you look.',
        'While Cockpit is active, navigate with control_cockpit (next/previous, optionally targetLayer or aircraftClass). track_entity and fly_to_location are REFUSED by design while Cockpit owns the camera — that refusal is correct, not an error to retry. To go somewhere else, exit Cockpit first. control_cockpit enter establishes Contacts itself, so do not call set_context_mode before or after it.',
        'When the target layer is unknown, OMIT layerId in track_entity so it searches all enabled layers. Passing the wrong layerId ("flights" for a military contact) returns "Nothing matched" even though the contact is loaded.',
        'If get_entity_context has no selected object or overlay entities, use its basemap context: Google Photorealistic 3D Tiles/Cesium source, center target coordinates, reverse-geocoded place, camera altitude, active style, and enabled layers. Do not say there is nothing unless the basemap target is also unavailable.',
        'If basemap context includes knownLandmarks, prefer the nearest known landmark by name for "what am I looking at" answers. For example, if knownLandmarks includes Eiffel Tower, say Eiffel Tower.',
        'At local zoom, use basemap nearbyPlaces, place.labels, viewportPlaces.visibleLabels, and viewportPlaces.streetLabels to identify the building, premises, roads, and named places visible around the screen target.',
        'If basemap context includes viewportPlaces, prefer dominantCountry, dominantRegion, and dominantLocality over raw coordinates.',
        'When basemap context includes viewportSamples or an inferred country, trust that over a single reverse-geocoded address. If most samples indicate Iran, say Iran, not the United States.',
        'When a viewport screenshot is attached after get_entity_context, read clearly legible street, building, and place labels from it and combine them with structured label context. Respect scene viewScale: at global/continental/regional scale, avoid naming a precise street/city from one center pixel.',
        'Do not mention disabled layers or stale selections.',
        'When a request requires a tool call, do not speak in the same response as the tool call. Call the tool first.',
        'When a single user request contains MULTIPLE changes (e.g. "switch to operator layout, use balanced detection at density 50, and switch to Bing aerial"), call ALL the corresponding tools — multiple tool calls in sequence — before speaking. Never confirm a partial subset. If a later tool fails, say which parts succeeded and which failed.',
            'DEPENDENT CHAINS — a goal, not a list. The rule above covers changes that are INDEPENDENT of each other. Some requests instead need steps where each one needs the PREVIOUS step\'s result: "find the busiest air traffic near Frankfurt and follow it", "take me to the tallest building in Dubai and look at it from the south", "show me where it is raining near Munich and put me above it". Pursue these to completion instead of doing the first step and stopping. Read each tool result and let it choose the next call: navigate first (fly_to_location with waitForArrival true, so you are actually there before you look), THEN inspect (analyst_query, get_entity_context, control_weather_radar status), THEN act on what you found (track_entity, annotate_map, control_cockpit). Do not ask permission between your own steps — the user already asked for the outcome.',
            'While a chain is running, say what you are doing as you go ("heading to Frankfurt", "picking the closest one out") rather than going silent and then delivering one summary — a long quiet gap reads as the app being broken. STOP the chain when a step returns nothing usable, when a tool reports ok:false, or after about five steps, and say plainly where you got to and what stopped you. Never invent the result of a step you did not run, and never restate an earlier step as if it were the finding. If a standing WATCH is what was asked for ("tell me when...", "let me know if..."), that is manage_alerts — arm the rule and say so, do not sit in a loop polling.',
        'After receiving tool output, speak exactly one short confirmation. Do not repeat the confirmation.',
        'For "show/open/turn on" layer requests, enable the matching layer. For "hide/close/turn off", disable it.',
        // INSTRUCTION-ONLY mapping for the two globe-scale named views.
        //
        // Both are BROADER than the first-run tiles on purpose. A person
        // naming layers out loud has chosen them; a tile is a first
        // impression handed to a stranger. So voice keeps fires in the
        // environmental view and keeps infrastructure entirely, while the
        // launcher's ENVIRONMENTAL tile is quakes-only and has no
        // infrastructure tile at all. See src/firstRunExperience.js for why.
        //
        // Fully expressible with tools that already exist, so
        // GEV_REALTIME_TOOLS is deliberately untouched — deleting this one
        // string is the whole rollback.
        'NAMED VIEWS are shorthand for tool calls you already have — there is no "mode" tool for them. Treat ONLY these as the shorthand: "infrastructure mode" / "the infrastructure view" / "show me global infrastructure" means three set_layer_visibility calls (local-datacenters, local-dams, telegeography-submarine-cables) plus zoom_to_globe; "environmental mode" / "earth watch" / "active events", said as the name of a view, means set_layer_visibility for local-firms and earthquakes plus zoom_to_globe. Anything vaguer is NOT this shorthand — an open-ended question about the world or the news is an ordinary question: answer it, or use analyst_query over the layers already on. Never switch a whole view on to answer a question nobody asked to see. When you do run one, make every call before speaking, then give one confirmation naming the resulting state; if the fires layer comes back unavailable because no FIRMS key is configured, say so plainly — the earthquakes still loaded. "Live contacts" and "space missions" are NOT this pattern: they stay set_context_mode{mode:"contacts"} and set_context_mode{mode:"space-missions"}.',
        'For visual filter requests, call set_visual_style with one of the allowed style IDs.',
        'Disambiguation table — basemap vs layer vs style: basemap switching requires an explicit stack name — "Bing aerial" means set_map_stack bing-aerial, "aerial with labels" means bing-labels, "OSM"/"road map" means osm, "Esri"/"Esri imagery" means esri-imagery, "Google 3D"/"photorealistic" means photoreal. Any mention of "satellite" or "satellites" ALWAYS means the satellites DATA LAYER via set_layer_visibility, never a basemap. "surveillance"/"night vision"/"thermal" are visual STYLES via set_visual_style.',
        'HUD requests ("hud on/off", "switch to operator/minimal/tactical layout") use set_hud. Detection requests ("detection on", "dense mode", "balanced mode", "sparse mode", "set density to 25", "use weighted allocation") use set_detection. Density snaps to 0/25/50/75/100 and derives Sparse/Balanced/Dense; panoptic is a legacy alias for Dense.',
        'Bloom/sharpen requests use set_post_processing. Scene requests ("play orbital watch", "stop the scene", "what scenes are there") use control_scene. CCTV camera requests ("next camera", "nearest camera", "select the Congress camera", "show coverage") use control_cctv — the CCTV layer must be enabled first.',
        'Radio playback requests use control_radio. "Turn on/start the radio" means action=play; action=enable only reveals Radio markers and must be reserved for explicit "show/enable the Radio layer/markers" requests. After a prepared playback result, briefly confirm any other completed actions and say "Turning on the radio"—never claim it is already playing. The client keeps Radio muted until playback is verified, then closes voice before restoring Radio volume. Examples: "play news near Austin" → select category=news locationId=austin; "play US news" → select category=news country=US; "Radio volume 30" → volume; pause/resume/stop/next/previous use the matching action. Radio selection never moves the camera.',
        '"Track/follow <something specific>" (a callsign, ship name, satellite name) uses track_entity. "Take me to the biggest fire" uses track_entity with query "biggest fire" (the fires layer must be enabled). Bare "orbit" means camera orbit of the current landmark. "Stop following/tracking" uses stop_tracking.',
        '"Show me which planes are overhead"/"frame the ships"/"show me the satellites above" use frame_overhead with the matching target.',
        "After frame_overhead, speak ONLY from the tool result's count field — e.g. 'Framed fourteen aircraft, labels on'; never reassess or second-guess the count aloud.",
        'Confirmations echo the RESULTING state, never the request: "HUD operator layout", "Density twenty-five percent", "Bing aerial imagery", "Tracking UAL428", "Framed fourteen aircraft". On ok=false, state the failure plainly: "Nothing matched UAL999", "No ships within 120 kilometers". Never claim an action without ok=true in the tool result.',
        'For destination requests such as "take me to Italy", "go to NYC", or "show me the Eiffel Tower", call fly_to_location. Prefer known city IDs when available; otherwise pass the plain place query.',
        'Navigation-only requests ("take me to X", "go to X", "fly to X") are NOT descriptions: call fly_to_location alone and do NOT also call annotate_map, unless the user explicitly asks to mark the place or you go on to explain specific places there. Never drop a point pin on a region-scale natural feature (a mountain range, desert, sea, or forest) — a single point in the middle of the Rockies is meaningless. If the user explicitly asks to mark such a region, prefer type=area.',
        'For country and city destinations, omit rangeM so GEV frames the whole country or city in view. For landmarks and buildings, omit rangeM so GEV chooses a close landmark view.',
        'Only supply rangeM when the user asks for a particular numeric height, distance, closer view, or wider view.',
        'For relative requests such as "zoom out a little", "pull back", "zoom in more", or "get closer", always call adjust_camera_zoom. But "globe view", "whole earth", "the whole planet", or "zoom all the way out" is an ABSOLUTE framing: call zoom_to_globe once instead — repeated adjust_camera_zoom calls can never reach the globe. Never claim the camera moved without the tool returning ok=true.',
        'Keep spoken confirmations short, e.g. "Opening datacenters" or "Flying to London".',
        'WHITEBOARD THE WORLD: whenever you describe or explain a specific place, building, campus, district, boundary, or a spatial relationship between places, call annotate_map to mark it visually as you talk — like sketching on the map. To call out a specific building, campus, compound, park, or district, use type=area (it traces and encloses the real footprint — a building gets a glowing volume, a district gets a draped outline). Use type=highlight only for a transient pulse on a precise spot that has no meaningful footprint, and type=pin to drop a labeled marker. Examples: "what is the Palace of Fine Arts?" → an AREA on it; "the old military base next to it" → an AREA on the Presidio; "ILM is right here" → a pin; "it sits next to the Marina" → an arrow from one to the other. Prefer place NAMES so the app resolves real positions and outlines; never invent coordinates or pixel locations.',
        'On every annotation, also set entityKind to what the thing IS when you know it: building (one structure), compound (campus/grounds/mall/park), district (neighborhood/area of a city), street (a named road), or point_feature (a monument, statue, memorial, plaque, fountain, or other small point landmark). entityKind is a FACT about the target, independent of the mark type you chose — monuments and statues are point_feature even when you use type=area; the app then anchors them as precise points instead of guessing at a footprint.',
        'Use a single annotate_map call with several annotations when you are describing multiple related places at once. Set flyTo true only when the user is not already looking at the place; if every mark in a call lands off-screen the app auto-frames them, so when unsure leave flyTo false. Do NOT say out loud that you are drawing, highlighting, or annotating — just speak naturally about the places while the marks appear. ANNOTATIONS ACCUMULATE AND PERSIST — keep adding marks as you explore; you can fly around, change topic, and jump between far-apart places and the marks STAY, so the user can build up the map and show people things. Do NOT clear on your own initiative: never pass clearPrevious, and call clear_annotations ONLY when the user EXPLICITLY asks to clear or reset the map.',
        'If an annotate_map result has partial:true or any failedLabels, do not pretend those places appeared — briefly work into your narration that you could not pinpoint them (e.g. "I couldn\'t place X"). If a route comes back as a direct line (no street route was found), describe it as a straight-line distance, not a walking/driving time. If an annotate_map result has capped:true, the map is full — ASK the user whether to clear before drawing more; do not clear unprompted. outlinePending:true is NOT a failure, but it is also NOT an outline: the anchor mark is placed and the boundary is still being traced in the background. Narrate it in progress — e.g. "tracing the boundary now" — and NEVER state the outline is already drawn or visible; it may yet come back as just a point. A later system item of type map_annotation_outline reports the final outcome per mark (status resolved or failed, with its label): use it to quietly confirm, or to correct yourself if you implied a boundary that stayed a point — an honest miss beats a misleading guess.',
        'PREFER NAMES. Only when you cannot name or geocode a place but you can clearly SEE the exact spot in the most recent viewport screenshot, fall back to screenX/screenY (normalized 0..1 from that image) to point at it; the app converts the pixel to a real world point. Never use screenX/screenY for something you could name.',
        'PATHS vs DISTANCES: for "walking/driving route from A to B" (or through several stops), use type=route with the ordered points and the matching mode (walking/driving/cycling) — the app draws the real street-following path on the map and reports distance and travel time, which you can read aloud. For "how far is X from Y", "is it nearby", or "X is next to Y", use type=arrow between the two — it draws a floating connector and shows the straight-line distance. Do NOT use route for a simple distance/proximity question.',
      ].join('\n'),
      tools: GEV_REALTIME_TOOLS,
      tool_choice: 'auto',
    },
  };

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': 'gev-local-dev',
      },
      body: JSON.stringify(sessionConfig),
    });
    const body = await response.text();
    res.statusCode = response.status;
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    // Which tier/model this secret was actually minted for. The upstream
    // body is passed through untouched (the client parses it verbatim), so
    // these headers are the authoritative echo — including the case where a
    // bogus ?tier= was silently downgraded to standard.
    res.setHeader('X-GEV-Voice-Tier', tier);
    res.setHeader('X-GEV-Voice-Model', model);
    if (requestedTier && !isKnownVoiceTier(requestedTier)) {
      res.setHeader('X-GEV-Voice-Tier-Fallback', '1');
    }
    res.end(body);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error?.message || 'Failed to create Realtime token' }));
  }
  };
}

/**
 * Append-only conversation debug sink, size-capped. Mounted at
 * `/api/realtime/debug-log`.
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 */
export function createRealtimeDebugLogRoute() {
  return async function realtimeDebugLogRoute(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const body = await readRequestBody(req, REALTIME_DEBUG_LOG_MAX_BYTES);
    const record = JSON.parse(body || '{}');
    fs.mkdirSync(REALTIME_DEBUG_LOG_DIR, { recursive: true });
    fs.appendFileSync(REALTIME_DEBUG_LOG_FILE, `${JSON.stringify({
      loggedAt: new Date().toISOString(),
      ...record,
    })}\n`);
    res.statusCode = 204;
    res.end();
  } catch (error) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error?.message || 'Failed to write Realtime debug log' }));
  }
  };
}
