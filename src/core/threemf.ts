import type { Mesh } from './mesh';

export interface ThreeMfPart {
  name: string;
  /** #RRGGBB */
  color: string;
  mesh: Mesh;
}

export interface ThreeMfOptions {
  objectName: string;
  parts: ThreeMfPart[];
  /** Where to place the model's XY center on the build plate (mm). */
  plateCenter?: [number, number];
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

const num = (v: number): string => {
  const s = v.toFixed(4);
  return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
};

/**
 * Build the files of a 3MF package: one object made of one part per color.
 *
 * Every part is a mesh object carrying an object-level color from a standard
 * 3MF material color group (`pid`/`pindex`). Bambu Studio (2.5+) recognises
 * these on import and offers to create one filament per color, assigning each
 * part to its filament. Part names are stored in Bambu's
 * `Metadata/model_settings.config` so they show up in the object list. No
 * printer or filament presets are included; the user's own profiles apply.
 */
export function buildThreeMf(opts: ThreeMfOptions): Record<string, string> {
  const parts = opts.parts.filter((p) => p.mesh.triangles.length > 0);
  const colorGroupId = 1;
  const partId = (i: number): number => i + 2;
  const assemblyId = parts.length + 2;

  // Center the model on the plate.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of parts) {
    const pos = p.mesh.positions;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i] < minX) minX = pos[i];
      if (pos[i] > maxX) maxX = pos[i];
      if (pos[i + 1] < minY) minY = pos[i + 1];
      if (pos[i + 1] > maxY) maxY = pos[i + 1];
    }
  }
  const [cx, cy] = opts.plateCenter ?? [128, 128];
  const tx = parts.length ? cx - (minX + maxX) / 2 : 0;
  const ty = parts.length ? cy - (minY + maxY) / 2 : 0;

  const model: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
      'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">',
    '<metadata name="Application">ImageFlattener</metadata>',
    `<metadata name="Title">${esc(opts.objectName)}</metadata>`,
    '<resources>',
    `<m:colorgroup id="${colorGroupId}">`,
    ...parts.map((p) => `<m:color color="${p.color.toUpperCase()}FF"/>`),
    '</m:colorgroup>',
  ];
  parts.forEach((p, i) => {
    model.push(
      `<object id="${partId(i)}" type="model" name="${esc(p.name)}" pid="${colorGroupId}" pindex="${i}">`,
      '<mesh>',
      '<vertices>',
    );
    const pos = p.mesh.positions;
    const v: string[] = [];
    for (let k = 0; k < pos.length; k += 3) v.push(`<vertex x="${num(pos[k])}" y="${num(pos[k + 1])}" z="${num(pos[k + 2])}"/>`);
    model.push(v.join('\n'), '</vertices>', '<triangles>');
    const t = p.mesh.triangles;
    const tr: string[] = [];
    for (let k = 0; k < t.length; k += 3) tr.push(`<triangle v1="${t[k]}" v2="${t[k + 1]}" v3="${t[k + 2]}"/>`);
    model.push(tr.join('\n'), '</triangles>', '</mesh>', '</object>');
  });
  model.push(
    `<object id="${assemblyId}" type="model" name="${esc(opts.objectName)}">`,
    '<components>',
    ...parts.map((_, i) => `<component objectid="${partId(i)}"/>`),
    '</components>',
    '</object>',
    '</resources>',
    '<build>',
    `<item objectid="${assemblyId}" transform="1 0 0 0 1 0 0 0 1 ${num(tx)} ${num(ty)} 0"/>`,
    '</build>',
    '</model>',
  );

  const settings: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    `  <object id="${assemblyId}">`,
    `    <metadata key="name" value="${esc(opts.objectName)}"/>`,
    ...parts.flatMap((p, i) => [
      `    <part id="${partId(i)}" subtype="normal_part">`,
      `      <metadata key="name" value="${esc(p.name)}"/>`,
      '    </part>',
    ]),
    '  </object>',
    '</config>',
  ];

  return {
    '[Content_Types].xml': [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
      '<Default Extension="config" ContentType="text/xml"/>',
      '</Types>',
    ].join('\n'),
    '_rels/.rels': [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
      '</Relationships>',
    ].join('\n'),
    '3D/3dmodel.model': model.join('\n'),
    'Metadata/model_settings.config': settings.join('\n'),
  };
}
