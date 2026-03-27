cmake_minimum_required(VERSION 3.15)
cmake_policy(SET CMP0091 NEW)

project(audio_loopback)

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# Include N-API / node-addon-api headers
include_directories(${CMAKE_JS_INC})

file(GLOB SOURCE_FILES "src/*.cpp" "src/*.h")

add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB} ole32 avrt mmdevapi)

# node-addon-api headers
execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
target_include_directories(${PROJECT_NAME} PRIVATE ${NODE_ADDON_API_DIR})

target_compile_definitions(${PROJECT_NAME} PRIVATE NAPI_VERSION=8 NAPI_DISABLE_CPP_EXCEPTIONS)
