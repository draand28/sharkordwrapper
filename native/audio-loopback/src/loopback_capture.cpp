#include "loopback_capture.h"
#include <avrt.h>
#include <combaseapi.h>
#include <vector>

#ifndef E_TIMEOUT
#define E_TIMEOUT HRESULT_FROM_WIN32(ERROR_TIMEOUT)
#endif

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "avrt.lib")

// ── ActivationHandler ──────────────────────────────────────────────────────

ActivationHandler::ActivationHandler()
    : m_refCount(1)
    , m_hrActivate(E_FAIL)
    , m_punkAudioInterface(nullptr)
{
    m_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
}

ULONG ActivationHandler::AddRef() {
    return InterlockedIncrement(&m_refCount);
}

ULONG ActivationHandler::Release() {
    ULONG count = InterlockedDecrement(&m_refCount);
    if (count == 0) {
        if (m_event) CloseHandle(m_event);
        delete this;
    }
    return count;
}

HRESULT ActivationHandler::QueryInterface(REFIID riid, void** ppv) {
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
        *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        AddRef();
        return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
}

HRESULT ActivationHandler::ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) {
    HRESULT hrActivate = E_FAIL;
    IUnknown* punkInterface = nullptr;
    operation->GetActivateResult(&hrActivate, &punkInterface);
    m_hrActivate = hrActivate;
    m_punkAudioInterface = punkInterface;
    SetEvent(m_event);
    return S_OK;
}

HRESULT ActivationHandler::Wait(DWORD timeoutMs) {
    DWORD result = WaitForSingleObject(m_event, timeoutMs);
    if (result != WAIT_OBJECT_0) return E_TIMEOUT;
    return m_hrActivate;
}

HRESULT ActivationHandler::GetResult(IAudioClient** client) {
    if (!m_punkAudioInterface) return E_FAIL;
    HRESULT hr = m_punkAudioInterface->QueryInterface(__uuidof(IAudioClient), (void**)client);
    m_punkAudioInterface->Release();
    m_punkAudioInterface = nullptr;
    return hr;
}

// ── LoopbackCapture ────────────────────────────────────────────────────────

LoopbackCapture::LoopbackCapture() {
    m_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
}

LoopbackCapture::~LoopbackCapture() {
    Stop();
    if (m_stopEvent) {
        CloseHandle(m_stopEvent);
        m_stopEvent = nullptr;
    }
}

bool LoopbackCapture::Start(DWORD excludeProcessId, AudioDataCallback callback) {
    if (m_capturing) return false;

    m_callback = callback;

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool comInitialized = SUCCEEDED(hr) || hr == S_FALSE;

    // Set up process loopback activation params
    AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
    activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activationParams.ProcessLoopbackParams.TargetProcessId = excludeProcessId;
    activationParams.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT activateParams = {};
    activateParams.vt = VT_BLOB;
    activateParams.blob.cbSize = sizeof(activationParams);
    activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

    auto* handler = new ActivationHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;

    hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activateParams,
        handler,
        &asyncOp
    );

    if (FAILED(hr)) {
        handler->Release();
        if (comInitialized) CoUninitialize();
        return false;
    }

    hr = handler->Wait(5000);
    if (FAILED(hr)) {
        handler->Release();
        if (asyncOp) asyncOp->Release();
        if (comInitialized) CoUninitialize();
        return false;
    }

    hr = handler->GetResult(&m_audioClient);
    handler->Release();
    if (asyncOp) asyncOp->Release();

    if (FAILED(hr) || !m_audioClient) {
        if (comInitialized) CoUninitialize();
        return false;
    }

    // Get the mix format
    WAVEFORMATEX* pwfx = nullptr;
    hr = m_audioClient->GetMixFormat(&pwfx);
    if (FAILED(hr)) {
        m_audioClient->Release();
        m_audioClient = nullptr;
        if (comInitialized) CoUninitialize();
        return false;
    }

    m_sampleRate = pwfx->nSamplesPerSec;
    m_channels = pwfx->nChannels;

    // Initialize audio client: 20ms buffer, shared mode
    REFERENCE_TIME bufferDuration = 200000; // 20ms in 100ns units
    hr = m_audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        bufferDuration,
        0,
        pwfx,
        nullptr
    );
    CoTaskMemFree(pwfx);

    if (FAILED(hr)) {
        m_audioClient->Release();
        m_audioClient = nullptr;
        if (comInitialized) CoUninitialize();
        return false;
    }

    hr = m_audioClient->GetService(__uuidof(IAudioCaptureClient), (void**)&m_captureClient);
    if (FAILED(hr)) {
        m_audioClient->Release();
        m_audioClient = nullptr;
        if (comInitialized) CoUninitialize();
        return false;
    }

    ResetEvent(m_stopEvent);
    m_capturing = true;

    hr = m_audioClient->Start();
    if (FAILED(hr)) {
        m_captureClient->Release();
        m_captureClient = nullptr;
        m_audioClient->Release();
        m_audioClient = nullptr;
        m_capturing = false;
        if (comInitialized) CoUninitialize();
        return false;
    }

    m_thread = std::thread(&LoopbackCapture::CaptureThread, this);
    return true;
}

void LoopbackCapture::Stop() {
    if (!m_capturing) return;
    m_capturing = false;
    SetEvent(m_stopEvent);

    if (m_thread.joinable()) {
        m_thread.join();
    }

    if (m_audioClient) {
        m_audioClient->Stop();
    }
    if (m_captureClient) {
        m_captureClient->Release();
        m_captureClient = nullptr;
    }
    if (m_audioClient) {
        m_audioClient->Release();
        m_audioClient = nullptr;
    }
}

bool LoopbackCapture::IsCapturing() const {
    return m_capturing;
}

void LoopbackCapture::CaptureThread() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    DWORD taskIndex = 0;
    HANDLE task = AvSetMmThreadCharacteristicsW(L"Audio", &taskIndex);

    while (m_capturing) {
        // Wait for 10ms or stop event
        DWORD waitResult = WaitForSingleObject(m_stopEvent, 10);
        if (waitResult == WAIT_OBJECT_0) break;

        UINT32 packetLength = 0;
        HRESULT hr = m_captureClient->GetNextPacketSize(&packetLength);
        if (FAILED(hr)) break;

        while (packetLength > 0) {
            BYTE* data = nullptr;
            UINT32 numFrames = 0;
            DWORD flags = 0;

            hr = m_captureClient->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr);
            if (FAILED(hr)) break;

            if (numFrames > 0 && m_callback) {
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    // Send silence
                    std::vector<float> silence(numFrames * m_channels, 0.0f);
                    m_callback(silence.data(), numFrames, m_channels, m_sampleRate);
                } else {
                    m_callback(reinterpret_cast<const float*>(data), numFrames, m_channels, m_sampleRate);
                }
            }

            m_captureClient->ReleaseBuffer(numFrames);

            hr = m_captureClient->GetNextPacketSize(&packetLength);
            if (FAILED(hr)) break;
        }
    }

    if (task) AvRevertMmThreadCharacteristics(task);
    CoUninitialize();
}
