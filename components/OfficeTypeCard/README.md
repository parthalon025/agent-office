# OfficeTypeCard

A flat picture and badge for one office type. Use it in pickers and docs, where a live 3D room is too heavy. The picture is drawn from the tokens of the theme the card sits in (`AgentOffice.officePicture`), in the dark or retro style of the theme's `AgentOffice.MODES` entry, so every theme has its own picture and no theme falls back to another. The card reads the tokens after its first render. `assets/Offices` has the pictures of the first theme as files.

## Props

| Prop | Required | Type |
| --- | --- | --- |
| `type` | yes | `OfficeType` |
| `note` | no | `string` |
