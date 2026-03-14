const MAX_IMAGE_SIZE = 200 * 1024 // 200KB
const MAX_IMAGE_WIDTH = 1200
const THUMBNAIL_WIDTH = 300

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = dataUrl
  })
}

function canvasToDataUrl(canvas: HTMLCanvasElement, quality: number): string {
  return canvas.toDataURL('image/jpeg', quality)
}

export function estimateBase64Size(dataUrl: string): number {
  // data:image/jpeg;base64, prefix is ~23 chars
  const base64 = dataUrl.split(',')[1] ?? ''
  return Math.ceil((base64.length * 3) / 4)
}

export async function compressImage(file: File): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file)
  const img = await loadImage(dataUrl)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!

  let { width, height } = img
  if (width > MAX_IMAGE_WIDTH) {
    height = Math.round((height * MAX_IMAGE_WIDTH) / width)
    width = MAX_IMAGE_WIDTH
  }

  canvas.width = width
  canvas.height = height
  ctx.drawImage(img, 0, 0, width, height)

  // Iteratively reduce quality until under budget
  let quality = 0.8
  let result = canvasToDataUrl(canvas, quality)

  while (estimateBase64Size(result) > MAX_IMAGE_SIZE && quality > 0.1) {
    quality -= 0.1
    result = canvasToDataUrl(canvas, quality)
  }

  // If still over budget, scale down further
  if (estimateBase64Size(result) > MAX_IMAGE_SIZE) {
    const scale = 0.6
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    result = canvasToDataUrl(canvas, 0.6)
  }

  return result
}

export async function generateThumbnail(file: File): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file)
  const img = await loadImage(dataUrl)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!

  let { width, height } = img
  if (width > THUMBNAIL_WIDTH) {
    height = Math.round((height * THUMBNAIL_WIDTH) / width)
    width = THUMBNAIL_WIDTH
  }

  canvas.width = width
  canvas.height = height
  ctx.drawImage(img, 0, 0, width, height)

  return canvasToDataUrl(canvas, 0.6)
}

export async function extractExifDate(file: File): Promise<string | null> {
  try {
    const buffer = await file.arrayBuffer()
    const view = new DataView(buffer)

    // Check JPEG SOI marker
    if (view.getUint16(0) !== 0xFFD8) return null

    let offset = 2
    while (offset < view.byteLength - 2) {
      const marker = view.getUint16(offset)
      if (marker === 0xFFE1) {
        // APP1 (EXIF)
        const exifStart = offset + 4

        // Check "Exif\0\0"
        const exifHeader = String.fromCharCode(
          view.getUint8(exifStart),
          view.getUint8(exifStart + 1),
          view.getUint8(exifStart + 2),
          view.getUint8(exifStart + 3),
        )
        if (exifHeader !== 'Exif') return null

        const tiffStart = exifStart + 6
        const isLittleEndian = view.getUint16(tiffStart) === 0x4949

        const ifdOffset = view.getUint32(tiffStart + 4, isLittleEndian)
        const ifdStart = tiffStart + ifdOffset
        const entries = view.getUint16(ifdStart, isLittleEndian)

        for (let i = 0; i < entries; i++) {
          const entryOffset = ifdStart + 2 + i * 12
          const tag = view.getUint16(entryOffset, isLittleEndian)

          // 0x0132 = DateTime, 0x9003 = DateTimeOriginal
          if (tag === 0x0132 || tag === 0x9003) {
            const valueOffset = view.getUint32(entryOffset + 8, isLittleEndian)
            const dateStr = readAscii(view, tiffStart + valueOffset, 19)
            // Format: "YYYY:MM:DD HH:MM:SS" -> "YYYY-MM-DD"
            const match = dateStr.match(/^(\d{4}):(\d{2}):(\d{2})/)
            if (match) return `${match[1]}-${match[2]}-${match[3]}`
          }
        }

        // Check sub-IFD for DateTimeOriginal
        for (let i = 0; i < entries; i++) {
          const entryOffset = ifdStart + 2 + i * 12
          const tag = view.getUint16(entryOffset, isLittleEndian)
          if (tag === 0x8769) {
            // ExifIFDPointer
            const subIfdOffset = view.getUint32(entryOffset + 8, isLittleEndian)
            const subIfdStart = tiffStart + subIfdOffset
            const subEntries = view.getUint16(subIfdStart, isLittleEndian)

            for (let j = 0; j < subEntries; j++) {
              const subEntryOffset = subIfdStart + 2 + j * 12
              const subTag = view.getUint16(subEntryOffset, isLittleEndian)
              if (subTag === 0x9003 || subTag === 0x9004) {
                const valOffset = view.getUint32(subEntryOffset + 8, isLittleEndian)
                const dateStr = readAscii(view, tiffStart + valOffset, 19)
                const match = dateStr.match(/^(\d{4}):(\d{2}):(\d{2})/)
                if (match) return `${match[1]}-${match[2]}-${match[3]}`
              }
            }
          }
        }

        return null
      }

      if ((marker & 0xFF00) !== 0xFF00) break
      const segLength = view.getUint16(offset + 2)
      offset += 2 + segLength
    }
    return null
  } catch {
    return null
  }
}

function readAscii(view: DataView, offset: number, length: number): string {
  let str = ''
  for (let i = 0; i < length && offset + i < view.byteLength; i++) {
    const ch = view.getUint8(offset + i)
    if (ch === 0) break
    str += String.fromCharCode(ch)
  }
  return str
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
