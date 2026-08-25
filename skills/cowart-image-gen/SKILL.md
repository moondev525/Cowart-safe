---
name: cowart-image-gen
description: Generate and place a final AI bitmap on the Cowart canvas, replacing a selected AI 图片 holder or inserting the image into the current page.
---

# Cowart Image Gen

Use this skill when the user wants an AI-generated image placed onto the Cowart canvas. A selected `AI 图片` holder gives a precise size and placement target, but it is not required. By default, a selected holder is a temporary target and should be replaced by the generated image.

## Preconditions

Ensure the `cowart_safe_mcp` tools required by this workflow are available. Do not call `render_cowart_canvas_widget` as a routine prerequisite: requests sent from the Cowart widget already have an open canvas, and the existing widget synchronizes inserted images from MCP-backed storage. If the user separately asks to open, reopen, or explicitly refresh the canvas, handle that request once with the canvas-opening workflow. Every direct MCP call must pass the active workspace as `projectDir`; never use or infer the plugin repository as project storage.

Cowart state is read and written through Cowart MCP tools, not through a localhost browser service.

New holders are tldraw `frame` shapes with:

```json
{
  "type": "frame",
  "meta": {
    "cowartAiImageHolder": true
  }
}
```

Older canvases may still contain legacy `geo` rectangle holders with the same
meta flag. Support both shapes.

## Workflow

1. Read the selected shape from Cowart with the MCP `get_cowart_selection` tool. Pass the active user project directory as `projectDir`.

2. Check whether exactly one selected shape is an AI image holder. A holder is any selected shape with either:

   ```text
   isAiImageHolder: true
   ```

   or:

   ```text
   meta.cowartAiImageHolder: true
   ```

   If yes, use the holder replacement workflow below. If not, do not ask the user to select a holder; use the standalone workflow below and insert the generated image into the current Cowart page.

3. Choose the placement workflow.

   Holder replacement workflow: use the selected holder's `props.w` and `props.h` as the size contract for both generation and placement. Before generating, derive and keep these values:

   - `targetWidth`: selected holder `props.w`
   - `targetHeight`: selected holder `props.h`
   - `targetAspectRatio`: the reduced `targetWidth:targetHeight` ratio when it maps cleanly, plus the decimal `targetWidth / targetHeight`

   If the selected holder matches a Cowart ratio preset such as `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, or `9:16`, use that preset label as the human-readable aspect ratio. The generated image should be composed for this target size and aspect ratio, and should not rely on later stretching or cropping to fit the holder.

   The generated image should replace the selected holder as a normal tldraw image shape:

   - `parentId`: same parent as the holder
   - `x`, `y`, `rotation`: same as the holder
   - `props.w`, `props.h`: same as the holder

   This leaves the final canvas with an image shape at the holder's position, not an AI holder that contains an image. Only preserve the holder when the user explicitly asks to keep the reusable slot.

   Standalone workflow: when no AI holder is selected, generate the image anyway and insert it as a normal image shape on the current page. Prefer the current page from Cowart view state; if there is a selected non-holder shape and it is useful as context, place the image beside it, otherwise place it in a clear page area. If the user requested a size or aspect ratio, pass that size and ratio into generation and use it for display. Otherwise, use the generated bitmap's natural aspect ratio and a practical display width such as 512 canvas units.

4. Generate the bitmap with the built-in `imagegen` skill unless the user explicitly requests another image path. If the requested asset needs visible copy, labels, poster text, ad text, UI text, or typography, include that text directly in the image generation prompt and let the image model produce the final bitmap. Do not default to generating a text-free background and then adding text locally unless the user explicitly asks for local typography, deterministic text overlay, SVG/vector output, or another non-imagegen layout step.

   For the holder workflow, the image generation request must explicitly include the selected holder's target size and aspect ratio. Add this information to the model prompt, for example:

   ```text
   Target canvas slot: 512 x 683 canvas units.
   Target aspect ratio: 3:4 (0.75 width/height).
   Compose the final bitmap for this portrait ratio so it fits the slot without cropping or stretching.
   ```

   If the image generation tool or model accepts size or aspect-ratio parameters, pass the closest supported option in addition to the prompt text. If only prompt text is available, the prompt text must still include `targetWidth`, `targetHeight`, and `targetAspectRatio`.

   Resolve the current generation result through an explicit handoff before inserting it into Cowart.

   Preferred resolution order:

   - Prefer an exact local path returned by the current image generation tool and pass it to `insert_cowart_image` as `imagePath`.
   - If no path is available and the tool returns the current image as a base64-encoded `data:` URL or raw base64 payload, pass that exact result directly as `dataUrl` or `dataBase64`; include `mimeType` with `dataBase64` when available. Direct payloads are limited to 16 MiB of decoded image data.
   - Provide exactly one of `imagePath`, `dataUrl`, or `dataBase64`. Never send multiple image sources in one insertion call.
   - If the current result exceeds the direct-payload limit or exposes none of those supported handoffs, ask the active provider or user to save/export that exact result to an explicit project `OUTPUT_DIR` and then use the returned path. Do not split a bitmap across calls or retry the same oversized payload.
   - Never inspect Codex session JSONL, guess files from `$CODEX_HOME/generated_images`, or scan unrelated caches to recover an image payload.

   Before insertion, visually inspect the current result or its exact local file and confirm it is the newly generated image for this request, not a stale asset. Do not paste a data payload into logs or prose.

   Let `insert_cowart_image` validate and save the bitmap into the selected page's project-local asset folder:

   ```text
   canvas/pages/<page-id-without-page-prefix>/assets/
   ```

5. Insert the generated image as a new tldraw image shape.

   For the holder replacement workflow, call `insert_cowart_image` with exactly one explicit image source, the holder id as `anchorShapeId`, and leave `replaceAiImageHolder` unset or set it to `true`. The MCP tool will place the image exactly where the holder was and remove the holder shape:

   - `type`: `image`
   - `parentId`: same as holder parent
   - `x`, `y`, `rotation`: same as holder
   - `props.w`, `props.h`: same as holder
   - `props.assetId`: the new image asset id
   - `meta.cowartGeneratedForAiImageHolder`: holder shape id
   - `meta.cowartReplacedAiImageHolder`: `true`

   If the user explicitly asks to keep the AI holder reusable, call `insert_cowart_image` with `replaceAiImageHolder: false`; for frame holders that legacy mode inserts the generated image as a child of the frame.

   For the standalone workflow, insert it into the current page as a normal image:

   - `type`: `image`
   - `parentId`: current page id, unless placing beside a selected non-holder shape requires the same parent
   - `x`, `y`: a clear page area or beside the selected non-holder shape
   - `rotation`: `0`
   - `props.w`, `props.h`: display size matching the generated bitmap aspect ratio
   - `props.assetId`: the new image asset id
   - `meta.cowartGeneratedStandalone`: `true`

6. Delete the selected holder by default as part of replacement. In the standalone workflow, do not create a holder first unless the user explicitly asks for one.

7. Save through Cowart MCP. Prefer `insert_cowart_image` for inserting the generated bitmap, or use `save_cowart_canvas_state` only when you must update the whole tldraw snapshot.

   Prefer page-local asset URLs in the image asset:

   ```text
   /page-assets/<page-id-without-page-prefix>/<filename>
   ```

8. Let the Cowart widget refresh from MCP-backed storage, then confirm the inserted shape id, final dimensions, target aspect ratio, saved asset path, and replaced holder id when the holder replacement workflow was used.

## Notes

- If the holder is a legacy rotated `geo` rectangle, preserve the same `rotation` on the replacement image.
- If there is already a generated image inside the holder from an older Cowart version, replacing the holder should remove the holder and its child image shape, then create one normal image shape in the holder's former position.
- Do not refuse generation solely because no `AI 图片` holder is selected. Generate the bitmap and insert it into the current Cowart page.
- Never overwrite an existing asset file; use a timestamped filename.
