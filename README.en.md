# Trainsworld Navigator

[日本語](README.md)

**A route planner for the railway you built in Trainsworld.**

Trainsworld Navigator is an unofficial companion to the browser game [Trainsworld](https://anita.garden/trainsworld/). Import a save to plan a journey on your own network, explore stations and stopping patterns, or compare a trip before and after you build a new line. It runs locally in your browser.

## What you can do

- Search by departure time or arrival deadline and compare routes by duration, transfers, or fare when supported.
- See estimated times at intermediate stops, transfer platforms, and the route on a map.
- Compare stopping patterns for services in the same line group.
- Compare the same journey across two saves using the same search settings.
- Use the app in a browser tab or in the Chrome or Firefox sidebar.

## Get started

1. Install Node.js 22 or newer, then clone or download this repository.
2. Run `npm start` in the project folder and open [http://127.0.0.1:4173/](http://127.0.0.1:4173/).
3. In Trainsworld, open **Saved games** and select **Download as a file** for your save.
4. Import the file, select your departure and arrival stations, and search.

The app supports verified rail and ferry records in TWG1 saves with TWT4–TWT6 track data. Bus services can appear in the catalogue, but generated bus stops are outside the route planner’s coverage. Journey times are estimates. The app processes saves locally and stores imported copies in your browser.

## Browser sidebar

Download the Chrome or Firefox ZIP from [GitHub Releases](https://github.com/burugou05-wq/trainsworld-navigator/releases/latest) and extract it. To build from source, run `npm run build` and use the corresponding folder in `dist`.

- **Chrome** — Open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select the extracted Chrome folder or `dist/chrome`.
- **Firefox** — Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `manifest.json` from the extracted Firefox folder or `dist/firefox`. The add-on is available until you restart Firefox.

## Compare two saves

Import both files and search for a journey in one save. Open the comparison panel in the results and choose the second save. Both results use the same requested time and search mode. The comparison shows duration, transfers, and the services used. You can choose the stations yourself if the automatic match is ambiguous.

## Optional game-calculated journey times

Run `node scripts/timing.mjs world.save world.twtime` to create a file with timing data for services the tool can verify against the game's published simulation assets. Import the resulting `.twtime` file as you would a regular save. The command retrieves the simulator assets and processes your save on your computer.

## Development

Run `npm test` for the test suite and `npm run build` to build all three versions. Run `npm run extract -- world.save` to inspect a save as JSON. See the [save-format notes](docs/save-format.md) and [verification report](docs/verification.md) for technical details in Japanese.
