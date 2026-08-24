--[[
  Atomic hourly-quota reservation across two independent counters.

  Why Lua: a send must be admitted only if BOTH the global hourly quota and the
  sender's own hourly quota have room. Doing that as two round-trips (check
  global, check sender, increment both) races under concurrency — two workers
  can both observe "1 slot left" and both take it, or one can increment the
  global counter and then discover the sender is full, leaking global quota.
  Redis runs this script atomically, so the check-and-reserve pair is indivisible.

  KEYS[1] = global counter key   e.g. rl:global:487654
  KEYS[2] = sender counter key   e.g. rl:sender:<uuid>:487654

  ARGV[1] = global limit          (integer)
  ARGV[2] = sender limit          (integer)
  ARGV[3] = key TTL in seconds    (integer, > window length so keys self-expire)
  ARGV[4] = retry delay in ms     (integer, ms until the next window opens)

  Returns on success: { 1, global_remaining, sender_remaining }
  Returns on refusal: { 0, retry_after_ms, scope }  where scope = "global" | "sender"
--]]

local global_key   = KEYS[1]
local sender_key   = KEYS[2]

local global_limit = tonumber(ARGV[1])
local sender_limit = tonumber(ARGV[2])
local ttl_seconds  = tonumber(ARGV[3])
local retry_after  = tonumber(ARGV[4])

local global_used = tonumber(redis.call('GET', global_key) or '0')
local sender_used = tonumber(redis.call('GET', sender_key) or '0')

-- Check both ceilings BEFORE mutating either one, so a refusal leaves no trace.
if global_used >= global_limit then
  return { 0, retry_after, 'global' }
end

if sender_used >= sender_limit then
  return { 0, retry_after, 'sender' }
end

local global_now = redis.call('INCR', global_key)
local sender_now = redis.call('INCR', sender_key)

-- Set the TTL only on the transition 0 -> 1. Refreshing it on every increment
-- would let a busy window slide forward indefinitely and never reset.
if global_now == 1 then
  redis.call('EXPIRE', global_key, ttl_seconds)
end
if sender_now == 1 then
  redis.call('EXPIRE', sender_key, ttl_seconds)
end

return { 1, global_limit - global_now, sender_limit - sender_now }
