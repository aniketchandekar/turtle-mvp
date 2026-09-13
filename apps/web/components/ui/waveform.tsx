"use client"

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
} from "react"

import { cn } from "@/lib/utils"

export type WaveformProps = HTMLAttributes<HTMLDivElement> & {
  data?: number[]
  barWidth?: number
  barHeight?: number
  barGap?: number
  barRadius?: number
  barColor?: string
  fadeEdges?: boolean
  fadeWidth?: number
  height?: string | number
  active?: boolean
  onBarClick?: (index: number, value: number) => void
}

export const Waveform = ({
  data = [],
  barWidth = 4,
  barHeight: baseBarHeight = 4,
  barGap = 2,
  barRadius = 2,
  barColor,
  fadeEdges = true,
  fadeWidth = 24,
  height = 128,
  onBarClick,
  className,
  ...props
}: WaveformProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const heightStyle = typeof height === "number" ? `${height}px` : height

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const resizeObserver = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1

      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`

      const ctx = canvas.getContext("2d")
      if (ctx) {
        ctx.scale(dpr, dpr)
        renderWaveform()
      }
    })

    const renderWaveform = () => {
      const ctx = canvas.getContext("2d")
      if (!ctx) return

      const rect = canvas.getBoundingClientRect()
      ctx.clearRect(0, 0, rect.width, rect.height)

      const computedBarColor =
        barColor ||
        getComputedStyle(canvas).getPropertyValue("--foreground") ||
        "#000"

      const barCount = Math.floor(rect.width / (barWidth + barGap))
      const centerY = rect.height / 2

      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor((i / barCount) * data.length)
        const value = data[dataIndex] || 0
        const barHeight = Math.max(baseBarHeight, value * rect.height * 0.8)
        const x = i * (barWidth + barGap)
        const y = centerY - barHeight / 2

        ctx.fillStyle = computedBarColor
        ctx.globalAlpha = 0.3 + value * 0.7

        if (barRadius > 0) {
          ctx.beginPath()
          ctx.roundRect(x, y, barWidth, barHeight, barRadius)
          ctx.fill()
        } else {
          ctx.fillRect(x, y, barWidth, barHeight)
        }
      }

      if (fadeEdges && fadeWidth > 0 && rect.width > 0) {
        const gradient = ctx.createLinearGradient(0, 0, rect.width, 0)
        const fadePercent = Math.min(0.2, fadeWidth / rect.width)

        gradient.addColorStop(0, "rgba(255,255,255,1)")
        gradient.addColorStop(fadePercent, "rgba(255,255,255,0)")
        gradient.addColorStop(1 - fadePercent, "rgba(255,255,255,0)")
        gradient.addColorStop(1, "rgba(255,255,255,1)")

        ctx.globalCompositeOperation = "destination-out"
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, rect.width, rect.height)
        ctx.globalCompositeOperation = "source-over"
      }

      ctx.globalAlpha = 1
    }

    resizeObserver.observe(container)
    renderWaveform()

    return () => resizeObserver.disconnect()
  }, [
    data,
    barWidth,
    baseBarHeight,
    barGap,
    barRadius,
    barColor,
    fadeEdges,
    fadeWidth,
  ])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onBarClick) return

    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return

    const x = e.clientX - rect.left
    const barIndex = Math.floor(x / (barWidth + barGap))
    const dataIndex = Math.floor(
      (barIndex * data.length) / Math.floor(rect.width / (barWidth + barGap))
    )

    if (dataIndex >= 0 && dataIndex < data.length) {
      onBarClick(dataIndex, data[dataIndex])
    }
  }

  return (
    <div
      className={cn("relative", className)}
      ref={containerRef}
      style={{ height: heightStyle }}
      {...props}
    >
      <canvas
        className="block h-full w-full"
        onClick={handleClick}
        ref={canvasRef}
      />
    </div>
  )
}

export type ScrollingWaveformProps = Omit<
  WaveformProps,
  "data" | "onBarClick"
> & {
  speed?: number
  barCount?: number
  data?: number[]
}

export const ScrollingWaveform = ({
  speed = 50,
  barCount = 60,
  barWidth = 4,
  barHeight: baseBarHeight = 4,
  barGap = 2,
  barRadius = 2,
  barColor,
  fadeEdges = true,
  fadeWidth = 24,
  height = 128,
  data,
  className,
  ...props
}: ScrollingWaveformProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const barsRef = useRef<Array<{ x: number; height: number }>>([])
  const animationRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  const seedRef = useRef(Math.random())
  const dataIndexRef = useRef(0)
  const heightStyle = typeof height === "number" ? `${height}px` : height

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const resizeObserver = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1

      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`

      const ctx = canvas.getContext("2d")
      if (ctx) {
        ctx.scale(dpr, dpr)
      }

      if (barsRef.current.length === 0) {
        const step = barWidth + barGap
        let currentX = rect.width
        let index = 0
        const seededRandom = (i: number) => {
          const x = Math.sin(seedRef.current * 10000 + i) * 10000
          return x - Math.floor(x)
        }
        while (currentX > -step) {
          barsRef.current.push({
            x: currentX,
            height: 0.2 + seededRandom(index++) * 0.6,
          })
          currentX -= step
        }
      }
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [barWidth, barGap])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const animate = (currentTime: number) => {
      const deltaTime = lastTimeRef.current
        ? (currentTime - lastTimeRef.current) / 1000
        : 0
      lastTimeRef.current = currentTime

      const rect = canvas.getBoundingClientRect()
      ctx.clearRect(0, 0, rect.width, rect.height)

      const computedBarColor =
        barColor ||
        getComputedStyle(canvas).getPropertyValue("--foreground") ||
        "#000"

      const step = barWidth + barGap
      for (let i = 0; i < barsRef.current.length; i++) {
        barsRef.current[i].x -= speed * deltaTime
      }

      barsRef.current = barsRef.current.filter(
        (bar) => bar.x + barWidth > -step
      )

      while (
        barsRef.current.length === 0 ||
        barsRef.current[barsRef.current.length - 1].x < rect.width
      ) {
        const lastBar = barsRef.current[barsRef.current.length - 1]
        const nextX = lastBar ? lastBar.x + step : rect.width

        let newHeight: number
        if (data && data.length > 0) {
          newHeight = data[dataIndexRef.current % data.length] || 0.1
          dataIndexRef.current = (dataIndexRef.current + 1) % data.length
        } else {
          const time = Date.now() / 1000
          const uniqueIndex = barsRef.current.length + time * 0.01
          const seededRandom = (index: number) => {
            const x = Math.sin(seedRef.current * 10000 + index * 137.5) * 10000
            return x - Math.floor(x)
          }
          const wave1 = Math.sin(uniqueIndex * 0.1) * 0.2
          const wave2 = Math.cos(uniqueIndex * 0.05) * 0.15
          const randomComponent = seededRandom(uniqueIndex) * 0.4
          newHeight = Math.max(
            0.1,
            Math.min(0.9, 0.3 + wave1 + wave2 + randomComponent)
          )
        }

        barsRef.current.push({
          x: nextX,
          height: newHeight,
        })
        if (barsRef.current.length > barCount * 2) break
      }

      const centerY = rect.height / 2
      for (const bar of barsRef.current) {
        if (bar.x < rect.width && bar.x + barWidth > 0) {
          const barHeight = Math.max(
            baseBarHeight,
            bar.height * rect.height * 0.6
          )
          const y = centerY - barHeight / 2

          ctx.fillStyle = computedBarColor
          ctx.globalAlpha = 0.3 + bar.height * 0.7

          if (barRadius > 0) {
            ctx.beginPath()
            ctx.roundRect(bar.x, y, barWidth, barHeight, barRadius)
            ctx.fill()
          } else {
            ctx.fillRect(bar.x, y, barWidth, barHeight)
          }
        }
      }

      if (fadeEdges && fadeWidth > 0) {
        const gradient = ctx.createLinearGradient(0, 0, rect.width, 0)
        const fadePercent = Math.min(0.2, fadeWidth / rect.width)

        gradient.addColorStop(0, "rgba(255,255,255,1)")
        gradient.addColorStop(fadePercent, "rgba(255,255,255,0)")
        gradient.addColorStop(1 - fadePercent, "rgba(255,255,255,0)")
        gradient.addColorStop(1, "rgba(255,255,255,1)")

        ctx.globalCompositeOperation = "destination-out"
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, rect.width, rect.height)
        ctx.globalCompositeOperation = "source-over"
      }

      ctx.globalAlpha = 1

      animationRef.current = requestAnimationFrame(animate)
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [
    speed,
    barCount,
    barWidth,
    baseBarHeight,
    barGap,
    barRadius,
    barColor,
    fadeEdges,
    fadeWidth,
    data,
  ])

  return (
    <div
      className={cn("relative flex items-center", className)}
      ref={containerRef}
      style={{ height: heightStyle }}
      {...props}
    >
      <canvas className="block h-full w-full" ref={canvasRef} />
    </div>
  )
}

export type MicrophoneWaveformProps = Omit<WaveformProps, "onError"> & {
  active?: boolean
  processing?: boolean
  fftSize?: number
  smoothingTimeConstant?: number
  sensitivity?: number
  onError?: (error: Error) => void
}

export const MicrophoneWaveform = ({
  active = false,
  processing = false,
  fftSize = 256,
  smoothingTimeConstant = 0.8,
  sensitivity = 1,
  onError,
  ...props
}: MicrophoneWaveformProps) => {
  const [data, setData] = useState<number[]>([])
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animationIdRef = useRef<number | null>(null)
  const processingAnimationRef = useRef<number | null>(null)
  const lastActiveDataRef = useRef<number[]>([])
  const transitionProgressRef = useRef(0)

  useEffect(() => {
    if (processing && !active) {
      let time = 0
      transitionProgressRef.current = 0

      const animateProcessing = () => {
        time += 0.03
        transitionProgressRef.current = Math.min(
          1,
          transitionProgressRef.current + 0.02
        )

        const processingData = []
        const barCount = 45

        for (let i = 0; i < barCount; i++) {
          const normalizedPosition = (i - barCount / 2) / (barCount / 2)
          const centerWeight = 1 - Math.abs(normalizedPosition) * 0.4

          const wave1 = Math.sin(time * 1.5 + i * 0.15) * 0.25
          const wave2 = Math.sin(time * 0.8 - i * 0.1) * 0.2
          const wave3 = Math.cos(time * 2 + i * 0.05) * 0.15
          const combinedWave = wave1 + wave2 + wave3
          const processingValue = (0.2 + combinedWave) * centerWeight

          let finalValue = processingValue
          if (
            lastActiveDataRef.current.length > 0 &&
            transitionProgressRef.current < 1
          ) {
            const lastDataIndex = Math.floor(
              (i / barCount) * lastActiveDataRef.current.length
            )
            const lastValue = lastActiveDataRef.current[lastDataIndex] || 0
            finalValue =
              lastValue * (1 - transitionProgressRef.current) +
              processingValue * transitionProgressRef.current
          }

          processingData.push(Math.max(0.05, Math.min(1, finalValue)))
        }

        setData(processingData)
        processingAnimationRef.current =
          requestAnimationFrame(animateProcessing)
      }

      animateProcessing()

      return () => {
        if (processingAnimationRef.current) {
          cancelAnimationFrame(processingAnimationRef.current)
        }
      }
    } else if (!active && !processing) {
      if (data.length > 0) {
        let fadeProgress = 0
        const fadeToIdle = () => {
          fadeProgress += 0.03
          if (fadeProgress < 1) {
            const fadedData = data.map((value) => value * (1 - fadeProgress))
            setData(fadedData)
            requestAnimationFrame(fadeToIdle)
          } else {
            setData([])
          }
        }
        fadeToIdle()
      }
      return
    }
  }, [processing, active])

  useEffect(() => {
    if (!active) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
      }
      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        audioContextRef.current.close()
      }
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current)
      }
      return
    }

    const setupMicrophone = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        })
        streamRef.current = stream

        const audioContext = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext)()
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = fftSize
        analyser.smoothingTimeConstant = smoothingTimeConstant

        const source = audioContext.createMediaStreamSource(stream)
        source.connect(analyser)

        audioContextRef.current = audioContext
        analyserRef.current = analyser

        const dataArray = new Uint8Array(analyser.frequencyBinCount)

        const updateData = () => {
          if (!analyserRef.current || !active) return

          analyserRef.current.getByteFrequencyData(dataArray)

          const startFreq = Math.floor(dataArray.length * 0.05)
          const endFreq = Math.floor(dataArray.length * 0.4)
          const relevantData = dataArray.slice(startFreq, endFreq)

          const halfLength = Math.floor(relevantData.length / 2)
          const normalizedData = []

          for (let i = halfLength - 1; i >= 0; i--) {
            const value = Math.min(1, (relevantData[i] / 255) * sensitivity)
            normalizedData.push(value)
          }

          for (let i = 0; i < halfLength; i++) {
            const value = Math.min(1, (relevantData[i] / 255) * sensitivity)
            normalizedData.push(value)
          }

          setData(normalizedData)
          lastActiveDataRef.current = normalizedData

          animationIdRef.current = requestAnimationFrame(updateData)
        }

        updateData()
      } catch (error) {
        onError?.(error as Error)
      }
    }

    setupMicrophone()

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
      }
      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        audioContextRef.current.close()
      }
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current)
      }
    }
  }, [active, fftSize, smoothingTimeConstant, sensitivity, onError])

  return <Waveform data={data} {...props} />
}

export type StaticWaveformProps = WaveformProps & {
  bars?: number
  seed?: number
}

export const StaticWaveform = ({
  bars = 40,
  seed = 42,
  ...props
}: StaticWaveformProps) => {
  const data = useMemo(() => {
    const random = (seedValue: number) => {
      const x = Math.sin(seedValue) * 10000
      return x - Math.floor(x)
    }

    return Array.from({ length: bars }, (_, i) => 0.2 + random(seed + i) * 0.6)
  }, [bars, seed])

  return <Waveform data={data} {...props} />
}
