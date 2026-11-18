<?php
// BENCHMARK: safe - explicit model field allowlist

$user->update($request->only(['display_name', 'timezone']));
