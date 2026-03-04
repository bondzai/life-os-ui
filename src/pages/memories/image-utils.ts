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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
