# BLINGO — AI Video Generation Tools & Workflow

## RECOMMENDED AI VIDEO GENERATORS (as of July 2026)

### Tier 1: Text/Image-to-Video (Best for full scene generation)

| Tool | Link | Best For | Notes |
|------|------|----------|-------|
| **Runway Gen-3 / Gen-4** | https://runwayml.com | Full cinematic scenes, character consistency | Best overall. Supports image-to-video with motion brush. Can maintain character designs across shots. |
| **Kling AI** | https://klingai.com | High-quality character animation, long clips | 2-minute max clips. Good at maintaining characters across frames. |
| **Pika Labs** | https://pika.art | Quick stylized clips, lip sync | Fast generation. Good for short action shots. |
| **Luma Dream Machine** | https://lumalabs.ai/dream-machine | Photorealistic 3D scenes | Very realistic lighting and physics. Good for establishing shots and environments. |
| **Hailuo AI (MiniMax)** | https://hailuoai.video | Fast generation, good motion | 6-second clips. Reference image support. |

### Tier 2: Image Generation First (Generate frames, then animate)

| Tool | Link | Best For | Notes |
|------|------|----------|-------|
| **Midjourney** | https://midjourney.com | Character design, environment concept art | Best for generating consistent character reference images and environment shots |
| **DALL-E 3** | https://openai.com/dall-e-3 | Precise prompt following | Good at exact specifications, text rendering |
| **Stable Diffusion + ComfyUI** | https://github.com/comfyanonymous/ComfyUI | Custom workflows, batch generation | Full control. Use with IP-Adapter for character consistency across frames. |
| **Leonardo AI** | https://leonardo.ai | Character consistency, style reference | Good character reference features. |

### Tier 3: Character Consistency & Animation

| Tool | Link | Best For |
|------|------|----------|
| **Hedra** | https://hedra.com | Character animation, talking heads |
| **Viggle AI** | https://viggle.ai | Character motion transfer (video→character) |
| **AnimateDiff** | https://github.com/guoyww/AnimateDiff | Stable Diffusion animation, consistent characters |
| **EbSynth** | https://ebsynth.com | Keyframe interpolation — paint keyframes, AI fills between |

---

## RECOMMENDED WORKFLOW

### Phase 1: Character Reference Images
Generate each character as a still image first:
1. Use **Midjourney** or **DALL-E 3** to generate each cousin, boss, and zombie variant as a clean character sheet (front view, action pose)
2. Save all character reference images in `cutscene/refs/`
3. These become the "seed" images for video generation

### Phase 2: Environment Reference Images
1. Generate key locations: block overview, bank steps, church+graveyard, jelly park, Jelly House, floodlit lot
2. Save as environment references

### Phase 3: Key Frames
1. For each shot in the storyboard, generate a key frame still image
2. Ensure character and environment consistency using reference images as input

### Phase 4: Video Generation
1. Feed key frames + character references into **Runway Gen-3** or **Kling AI**
2. Use image-to-video with motion prompts
3. For action scenes, provide start + end frames

### Phase 5: Assembly & Audio
1. Edit clips together in any video editor (DaVinci Resolve, Premiere, CapCut)
2. Add toast text overlays matching game style
3. Add chip-synth music and SFX
4. Add title/end cards

---

## PROMPT TEMPLATES

### Character Generation Prompt
```
A cute squishy blob character, low-poly 3D style, cel-shaded, soft clay material. 
[COLOR NAME] colored round body with simple dot eyes and a small mouth. 
Holding a [WEAPON]. [STANCE DESCRIPTION]. 
Clean white background. Character reference sheet style. 
No background details. Full body visible. 
--ar 1:1 --style raw
```

### Environment Generation Prompt
```
Low-poly 3D town scene, [LOCATION DESCRIPTION], at [TIME OF DAY]. 
Game-accurate architectural style. [WEATHER CONDITIONS].
Warm street lamp glow. Soft shadows. 
--ar 16:9 --style raw
```

### Action Shot Prompt
```
A squishy [COLOR] blob character fighting zombies in a low-poly town street. 
The blob swings a [WEAPON] at [ZOMBIE DESCRIPTION]. 
Action pose, dynamic lighting, muzzle flash / impact effects. 
Night/dusk setting with orange street lamps. 
--ar 16:9
```

---

## FILE ORGANIZATION

```
cutscene/
├── STORYBOARD.md              ← Shot-by-shot storyboard
├── CHARACTERS.md              ← All character specs with colors and descriptions
├── WEAPONS_AND_PROPS.md       ← Weapons, items, environments
├── AI_TOOLS.md                ← This file
├── refs/                      ← Generated reference images
│   ├── cousins/
│   ├── bosses/
│   ├── zombies/
│   ├── weapons/
│   └── environments/
├── keyframes/                 ← Key frame stills for each shot
│   ├── shot01_establishing.png
│   ├── shot02_cousins.png
│   └── ...
└── output/                    ← Final video clips
```

---

## QUICK START: First Generation

1. Start with **Midjourney** — generate Blingo (orange blob with baseball bat) as a test:
   ```
   A cute squishy orange blob character, low-poly 3D cel-shaded style, soft clay material. 
   Round orange body with simple dot eyes and a small mouth. Holding a wooden baseball bat 
   resting on its shoulder. Confident stance. Full body. Clean white background. 
   --ar 1:1 --style raw
   ```

2. Once you have a Blingo you like, use it as a character reference for the other 5 cousins.

3. Generate the Rotten One:
   ```
   A massive putrid yellow-green squishy blob boss, 3x scale, low-poly 3D cel-shaded. 
   NO HORNS. Left chest gaping open — white bone ribs arcing over a visible beating dark red 
   heart inside. One eyeball hanging loose on a red optic stalk from the socket. 
   Menacing stance. Rainy night background with lightning. 
   --ar 16:9
   ```

4. Generate Bluga:
   ```
   A black squishy blob in a ski mask with ice-blue eye slits, "FBI" on its back in yellow. 
   Holding an SMG in one hand, a cracked jelly jar in the other. Purple jelly dripping. 
   Low-poly 3D cel-shaded. Menacing stance on a porch. 
   --ar 16:9
   ```
