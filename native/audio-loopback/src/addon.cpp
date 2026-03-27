#include <napi.h>
#include "loopback_capture.h"
#include <memory>

static std::unique_ptr<LoopbackCapture> g_capture;
static Napi::ThreadSafeFunction g_tsfn;

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (processId: number, callback: function)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    DWORD processId = info[0].As<Napi::Number>().Uint32Value();
    Napi::Function callback = info[1].As<Napi::Function>();

    // Stop any existing capture
    if (g_capture) {
        g_capture->Stop();
        g_capture.reset();
    }
    if (g_tsfn) {
        g_tsfn.Release();
    }

    g_tsfn = Napi::ThreadSafeFunction::New(
        env,
        callback,
        "AudioLoopbackCallback",
        0,   // unlimited queue
        1    // one thread
    );

    g_capture = std::make_unique<LoopbackCapture>();

    std::string error = g_capture->Start(processId,
        [](const float* data, uint32_t frameCount, uint32_t channels, uint32_t sampleRate) {
            if (!g_tsfn) return;

            uint32_t totalSamples = frameCount * channels;
            auto* dataCopy = new float[totalSamples];
            memcpy(dataCopy, data, totalSamples * sizeof(float));

            struct AudioPacket {
                float* data;
                uint32_t frameCount;
                uint32_t channels;
                uint32_t sampleRate;
            };

            auto* packet = new AudioPacket{dataCopy, frameCount, channels, sampleRate};

            g_tsfn.NonBlockingCall(packet,
                [](Napi::Env env, Napi::Function jsCallback, AudioPacket* pkt) {
                    uint32_t totalSamples = pkt->frameCount * pkt->channels;

                    auto buffer = Napi::Float32Array::New(env, totalSamples);
                    memcpy(buffer.Data(), pkt->data, totalSamples * sizeof(float));

                    jsCallback.Call({
                        buffer,
                        Napi::Number::New(env, pkt->channels),
                        Napi::Number::New(env, pkt->sampleRate)
                    });

                    delete[] pkt->data;
                    delete pkt;
                }
            );
        }
    );

    if (!error.empty()) {
        g_capture.reset();
        g_tsfn.Release();
        // Return the error string instead of false so JS can log it
        return Napi::String::New(env, error);
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    if (g_capture) {
        g_capture->Stop();
        g_capture.reset();
    }
    if (g_tsfn) {
        g_tsfn.Release();
    }
    return info.Env().Undefined();
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
    // Check Windows build >= 19041 (Windows 10 2004)
    OSVERSIONINFOEXW osvi = {};
    osvi.dwOSVersionInfoSize = sizeof(osvi);

    typedef NTSTATUS(WINAPI* RtlGetVersionFunc)(PRTL_OSVERSIONINFOW);
    auto RtlGetVersion = reinterpret_cast<RtlGetVersionFunc>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion")
    );

    if (RtlGetVersion) {
        RtlGetVersion(reinterpret_cast<PRTL_OSVERSIONINFOW>(&osvi));
        bool supported = (osvi.dwMajorVersion > 10) ||
            (osvi.dwMajorVersion == 10 && osvi.dwBuildNumber >= 19041);
        return Napi::Boolean::New(info.Env(), supported);
    }

    return Napi::Boolean::New(info.Env(), false);
}

Napi::Value IsCapturing(const Napi::CallbackInfo& info) {
    bool capturing = g_capture && g_capture->IsCapturing();
    return Napi::Boolean::New(info.Env(), capturing);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
    exports.Set("isSupported", Napi::Function::New(env, IsSupported));
    exports.Set("isCapturing", Napi::Function::New(env, IsCapturing));
    return exports;
}

NODE_API_MODULE(audio_loopback, Init)
