#pragma once

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <atomic>
#include <functional>
#include <thread>

// Available since Windows 10 2004 (build 19041)
#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

#ifndef AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
#define AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK 1
#endif

#ifndef PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
#define PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE 2
#endif

struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    DWORD TargetProcessId;
    DWORD ProcessLoopbackMode;
};

struct AUDIOCLIENT_ACTIVATION_PARAMS {
    DWORD ActivationType;
    union {
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    };
};

// Callback: (float* data, uint32_t frameCount, uint32_t channels, uint32_t sampleRate)
using AudioDataCallback = std::function<void(const float*, uint32_t, uint32_t, uint32_t)>;

class ActivationHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    ActivationHandler();

    // IUnknown
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override;

    // IActivateAudioInterfaceCompletionHandler
    HRESULT STDMETHODCALLTYPE ActivateCompleted(
        IActivateAudioInterfaceAsyncOperation* operation) override;

    HRESULT Wait(DWORD timeoutMs);
    HRESULT GetResult(IAudioClient** client);

private:
    LONG m_refCount;
    HANDLE m_event;
    HRESULT m_hrActivate;
    IUnknown* m_punkAudioInterface;
};

class LoopbackCapture {
public:
    LoopbackCapture();
    ~LoopbackCapture();

    bool Start(DWORD excludeProcessId, AudioDataCallback callback);
    void Stop();
    bool IsCapturing() const;

    uint32_t GetSampleRate() const { return m_sampleRate; }
    uint32_t GetChannels() const { return m_channels; }

private:
    void CaptureThread();

    IAudioClient* m_audioClient = nullptr;
    IAudioCaptureClient* m_captureClient = nullptr;
    HANDLE m_stopEvent = nullptr;
    std::thread m_thread;
    std::atomic<bool> m_capturing{false};
    AudioDataCallback m_callback;
    uint32_t m_sampleRate = 0;
    uint32_t m_channels = 0;
};
